#!/usr/bin/env bash
# net/bevy real-GPU client-render runner — scripted analogue of net/tools/realGpuRender.mjs
# (#191), for the NATIVE Bevy probe (#192). It turns the two-terminal "Manual real-GPU run"
# (net/bevy/CLAUDE.md) into ONE command: build once -> spawn the loaded authority ->
# run the windowed `--client` render probe against it -> let the in-app sidecar sink emit
# `ClientRenderSample` lines (basis `bevy-frame-diagnostics`, FRAME_TIME) via the shared
# `aggregate_render_window` -> exit cleanly (NO process leaks) -> write the sidecar + a
# provenance `.meta.json`.
#
# IMPORTANT — this REQUIRES a real GPU window and is an ATTENDED run, NOT a CI/headless job:
#   * The probe is the windowed `--client` (DefaultPlugins + wgpu + a real OS window). It is
#     NEVER the headless `--server`/`--scenario` path, so this runner can NOT accidentally
#     time the `ScheduleRunner` loop (which would be a FABRICATED magnitude — Core Value #1).
#   * Headless / no-display: window+adapter creation fails and the client exits non-zero, so
#     NO sidecar is produced (the honest safety net). If wgpu instead falls back to a SOFTWARE
#     adapter (`device_type: Cpu` / llvmpipe / SwiftShader), this runner ABORTS and writes
#     nothing — a "real-gpu" file is never produced from a software context (mirrors #191).
#   * vsync caveat: the window is vsync-capped, so `clientFps` flattens at the refresh rate and
#     HIDES headroom — frame-time p50/p95 is the PRIMARY metric, fps is a ceiling indicator.
#   * Keep the client window FOREGROUND + visible; allow a thermal cooldown between bot stages.
#   * §8.2 basis GAP: web (`web-raf-dt`) vs bevy (`bevy-frame-diagnostics`) magnitudes are NOT
#     cross-comparable — only the SHAPE under bot load is. Do NOT cross-compare absolute values.
#
# Sweep the ramp by re-running per stage (BOT_COUNT=2, then 24, then 100) with a cooldown
# between — mirroring the server `n2-stress-ramp` stages so the sidecars LEFT JOIN on the keys.
#
# Env knobs (all optional):
#   BOT_COUNT      loaded bot stage / botCount join key            (default 24)
#   SEED           RNG seed join key                               (default 12345)
#   TICK           server tick Hz join key                         (default 20)
#   SCENARIO       scenario join key                               (default n2-stress-ramp)
#   DELAY_CTOS_MS DELAY_STOC_MS LOSS_PCT   impairment join keys    (default 0)
#   WARMUP_MS      settling window excluded before measuring (ms)  (default 2000)
#   WINDOW_MS      measurement window length (windowDurationMs)    (default 4000)
#   MAX_WINDOWS    stop after this many KEPT windows               (default 3)
#   RENDER_OUT     output JSONL path  (default net/measurements/n2/bevy-client-render.realgpu.jsonl)
#   RELEASE        "1" to build/run --release (default dev profile, matches the manual doc)
#   SKIP_BUILD     "1" to skip `cargo build` and reuse the existing binary
#   ALLOW_SOFTWARE "1" to bypass the software-adapter guard (NEVER for a committed sidecar)
#   SERVER_READY_TIMEOUT  seconds to wait for the server's "listening on" line (default 120)
#   RUN_TIMEOUT           seconds to cap the client run             (default 300)

set -euo pipefail

# --- Resolve paths from this script so the runner is cwd-independent. ----------------
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BEVY_DIR="$(cd "$HERE/.." && pwd)"     # net/bevy
NET_ROOT="$(cd "$BEVY_DIR/.." && pwd)" # net

# --- Config (env with defaults) ------------------------------------------------------
BOT_COUNT="${BOT_COUNT:-24}"
SEED="${SEED:-12345}"
TICK="${TICK:-20}"
SCENARIO="${SCENARIO:-n2-stress-ramp}"
DELAY_CTOS_MS="${DELAY_CTOS_MS:-0}"
DELAY_STOC_MS="${DELAY_STOC_MS:-0}"
LOSS_PCT="${LOSS_PCT:-0}"
WARMUP_MS="${WARMUP_MS:-2000}"
WINDOW_MS="${WINDOW_MS:-4000}"
MAX_WINDOWS="${MAX_WINDOWS:-3}"
RELEASE="${RELEASE:-0}"
SKIP_BUILD="${SKIP_BUILD:-0}"
ALLOW_SOFTWARE="${ALLOW_SOFTWARE:-0}"
SERVER_READY_TIMEOUT="${SERVER_READY_TIMEOUT:-120}"
RUN_TIMEOUT="${RUN_TIMEOUT:-300}"

# Validate the numeric knobs up front: they are interpolated UNQUOTED into the
# meta.json join keys / window block, so a non-numeric, empty, or leading-zero value
# (the latter disallowed for JSON numbers by RFC 8259) would emit unparseable JSON.
# Fail fast with a clear message instead of writing a broken provenance file.
NUM_RE='^(0|[1-9][0-9]*)([.][0-9]+)?$'
for _pair in \
  "SEED=$SEED" "TICK=$TICK" "BOT_COUNT=$BOT_COUNT" \
  "DELAY_CTOS_MS=$DELAY_CTOS_MS" "DELAY_STOC_MS=$DELAY_STOC_MS" "LOSS_PCT=$LOSS_PCT" \
  "WARMUP_MS=$WARMUP_MS" "WINDOW_MS=$WINDOW_MS" "MAX_WINDOWS=$MAX_WINDOWS" \
  "SERVER_READY_TIMEOUT=$SERVER_READY_TIMEOUT" "RUN_TIMEOUT=$RUN_TIMEOUT"; do
  _name="${_pair%%=*}"
  _val="${_pair#*=}"
  if ! [[ "$_val" =~ $NUM_RE ]]; then
    echo "FATAL: env $_name='$_val' must be a non-negative number (int or decimal, no leading zeros)" >&2
    exit 2
  fi
done

DEFAULT_OUT="$NET_ROOT/measurements/n2/bevy-client-render.realgpu.jsonl"
RENDER_OUT="${RENDER_OUT:-$DEFAULT_OUT}"
META_OUT="${RENDER_OUT%.jsonl}.meta.json"

# Renderer markers that mean "software rasteriser", NOT a real GPU. A real-GPU file is
# never written if the client's wgpu adapter matches one of these (the whole point).
SOFTWARE_RE='device_type: Cpu|only supports software rendering|llvmpipe|SwiftShader|Microsoft Basic Render'

# --- Temp workspace + cleanup (kill the server tree on EVERY exit path; no leaks). ----
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/net-bevy-realgpu.XXXXXX")"
SERVER_LOG="$TMP_DIR/server.log"
CLIENT_LOG="$TMP_DIR/client.log"
TMP_JSONL="$TMP_DIR/out.jsonl"
SERVER_PID=""
CLIENT_PID=""

cleanup() {
  # Kill BOTH spawned processes on EVERY exit path (incl. an external SIGTERM mid-run,
  # e.g. a /dev-all harness terminating the script) so neither the loaded server nor
  # the windowed GPU client is ever leaked. Both are the net-bevy binary run directly
  # (no child fork), so a direct PID kill is complete + portable (macOS has no
  # `setsid`/process-group kill).
  if [ -n "$CLIENT_PID" ] && kill -0 "$CLIENT_PID" 2>/dev/null; then
    kill -KILL "$CLIENT_PID" 2>/dev/null || true
  fi
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$SERVER_PID" 2>/dev/null || break
      sleep 0.2
    done
    kill -KILL "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# --- 1. Build once (so server + client share one binary; no double-compile race). ----
# Branch instead of an args array: macOS stock bash is 3.2, where an empty
# `"${arr[@]}"` is an "unbound variable" under `set -u` (fixed only in bash 4.4+).
PROFILE_DIR="debug"
[ "$RELEASE" = "1" ] && PROFILE_DIR="release"
if [ "$SKIP_BUILD" != "1" ]; then
  echo "building net-bevy ($PROFILE_DIR)…" >&2
  if [ "$RELEASE" = "1" ]; then
    (cd "$BEVY_DIR" && cargo build --release)
  else
    (cd "$BEVY_DIR" && cargo build)
  fi
fi
TARGET_DIR="${CARGO_TARGET_DIR:-$BEVY_DIR/target}"
BIN="$TARGET_DIR/$PROFILE_DIR/net-bevy"
if [ ! -x "$BIN" ]; then
  echo "FATAL: binary not found at $BIN (build failed or wrong CARGO_TARGET_DIR?)" >&2
  exit 1
fi

echo "real-GPU runner — bots=$BOT_COUNT seed=$SEED tick=$TICK scenario=$SCENARIO" >&2
echo "  warmup=${WARMUP_MS}ms window=${WINDOW_MS}ms maxWindows=$MAX_WINDOWS -> $RENDER_OUT" >&2

# --- 2. Spawn the loaded authority (headless server WITH the seeded bot ramp). --------
# Run the binary directly (not via `cargo run`) so $! IS the server PID — cleanup()
# then kills exactly it. The server binds the hardcoded DEFAULT_PORT (5010); the client
# below connects there with no address arg.
SEED="$SEED" TICK="$TICK" BOT_COUNT="$BOT_COUNT" \
  "$BIN" --server-loaded >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

# Wait for the "listening on" line (or early exit / timeout).
deadline=$(( $(date +%s) + SERVER_READY_TIMEOUT ))
until grep -q "listening on" "$SERVER_LOG" 2>/dev/null; do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "FATAL: loaded server exited before it was ready. Log:" >&2
    cat "$SERVER_LOG" >&2 || true
    exit 1
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "FATAL: loaded server not ready within ${SERVER_READY_TIMEOUT}s" >&2
    exit 1
  fi
  sleep 0.25
done
echo "loaded server ready: $(grep 'listening on' "$SERVER_LOG" | tail -1)" >&2

# --- 3. Run the windowed render probe (writes to a TMP sidecar; foreground/blocks). ---
# RUST_LOG is forced so bevy_render's `AdapterInfo` (info) + the software-adapter warn
# always print to the client log, making the software guard reliable regardless of any
# inherited RUST_LOG. The probe self-exits (AppExit) after MAX_WINDOWS kept windows.
set +e
RUST_LOG="info,wgpu=warn,naga=warn" \
RENDER_PROBE=1 \
SCENARIO="$SCENARIO" SEED="$SEED" TICK="$TICK" BOT_COUNT="$BOT_COUNT" \
CLIENT_COUNT=1 CLIENT_INDEX=0 \
DELAY_CTOS_MS="$DELAY_CTOS_MS" DELAY_STOC_MS="$DELAY_STOC_MS" LOSS_PCT="$LOSS_PCT" \
WARMUP_MS="$WARMUP_MS" WINDOW_MS="$WINDOW_MS" MAX_WINDOWS="$MAX_WINDOWS" \
RENDER_OUT="$TMP_JSONL" \
  "$BIN" --client >"$CLIENT_LOG" 2>&1 &
CLIENT_PID=$!
# Cap the client run so a hung/throttled window (windows perpetually dropped, target
# never reached) can't wedge the script forever. Poll (no background watchdog ⇒ no
# lingering `sleep`); SIGKILL on timeout, then reap the exit code with `wait`.
elapsed=0
while kill -0 "$CLIENT_PID" 2>/dev/null; do
  if [ "$elapsed" -ge "$RUN_TIMEOUT" ]; then
    echo "WARNING: client hit RUN_TIMEOUT=${RUN_TIMEOUT}s — killing it." >&2
    kill -KILL "$CLIENT_PID" 2>/dev/null || true
    break
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done
wait "$CLIENT_PID" 2>/dev/null; CLIENT_RC=$?
set -e

# --- 4. Honesty guards: software adapter, client failure, empty output. ---------------
ADAPTER_LINE="$(grep -o 'AdapterInfo {[^}]*}' "$CLIENT_LOG" | tail -1 || true)"

if grep -Eq "$SOFTWARE_RE" "$CLIENT_LOG"; then
  if [ "$ALLOW_SOFTWARE" != "1" ]; then
    echo "ABORT: the client's wgpu adapter looks SOFTWARE (not a real GPU) — writing nothing." >&2
    echo "  adapter: ${ADAPTER_LINE:-<not logged>}" >&2
    echo "  Run ATTENDED on a real display/GPU; do NOT force a software adapter." >&2
    echo "  (Set ALLOW_SOFTWARE=1 only to inspect the software path — never for a committed sidecar.)" >&2
    exit 3
  fi
  echo "WARNING: software adapter detected but ALLOW_SOFTWARE=1 — magnitudes are NOT real-GPU." >&2
fi

if [ "$CLIENT_RC" -ne 0 ]; then
  echo "ABORT: render-probe client exited non-zero (rc=$CLIENT_RC) — writing nothing." >&2
  echo "  Likely no display / window or adapter creation failed (headless?). Client log tail:" >&2
  tail -n 20 "$CLIENT_LOG" >&2 || true
  exit "$CLIENT_RC"
fi

WINDOWS_CAPTURED=0
if [ -f "$TMP_JSONL" ]; then
  WINDOWS_CAPTURED="$(grep -c . "$TMP_JSONL" || true)"
fi
if [ "$WINDOWS_CAPTURED" -lt 1 ]; then
  echo "ABORT: no sidecar samples kept (every window throttled/short, or window never settled)." >&2
  echo "  Keep the client window FOREGROUND + visible; redraw throttles when occluded." >&2
  exit 4
fi

# --- 5. Publish: move the TMP sidecar to RENDER_OUT + write the provenance meta.json. -
mkdir -p "$(dirname "$RENDER_OUT")"
mv "$TMP_JSONL" "$RENDER_OUT"

# JSON-escape the adapter line (backslash + double-quote) for the meta.json string value.
ADAPTER_JSON="$(printf '%s' "${ADAPTER_LINE:-unknown}" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
SOFTWARE_FLAG="false"
[ "$ALLOW_SOFTWARE" = "1" ] && SOFTWARE_FLAG="true"
CAPTURED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
SIDECAR_BASENAME="$(basename "$RENDER_OUT")"

cat >"$META_OUT" <<JSON
{
  "backend": "real-gpu",
  "engine": "bevy",
  "measurementBasis": "bevy-frame-diagnostics",
  "allowSoftwareBypass": $SOFTWARE_FLAG,
  "gpuAdapterInfo": "$ADAPTER_JSON",
  "capturedAtIso": "$CAPTURED_AT",
  "host": "windowed-bevy-client",
  "joinKeys": {
    "scenario": "$SCENARIO",
    "seed": $SEED,
    "tickRate": $TICK,
    "botCount": $BOT_COUNT,
    "clientCount": 1,
    "injectedDelayCtoSMs": $DELAY_CTOS_MS,
    "injectedDelayStoCMs": $DELAY_STOC_MS,
    "lossPct": $LOSS_PCT
  },
  "window": {
    "warmupMs": $WARMUP_MS,
    "windowDurationMs": $WINDOW_MS,
    "maxWindows": $MAX_WINDOWS
  },
  "windowsCaptured": $WINDOWS_CAPTURED,
  "sidecar": "$SIDECAR_BASENAME"
}
JSON

echo "wrote $WINDOWS_CAPTURED real-GPU sample(s) -> $RENDER_OUT" >&2
echo "wrote provenance -> $META_OUT" >&2
echo "  adapter: ${ADAPTER_LINE:-<not logged>}" >&2
