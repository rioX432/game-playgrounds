# net/ N2 measurements — raw evidence for COMPARISON.md §8

These six `metrics.jsonl` files are the **actual runs** that back every number in
`COMPARISON.md` §8. Each line is one `MetricsSample` (`net/protocol/src/metrics.ts`,
the #140 schema) — append-only, one stage per line, self-describing (every line
carries its own `tickRate` / `clientCount` / `botCount` / `injectedDelay*` / `lossPct`).

## How they were produced

Single machine, localhost only: Apple Silicon Mac (arm64), macOS 26.6, Node v22,
Bevy native. **Same seed (`12345`), same scenario ids/stages across both stacks**,
so the web and Bevy lines join on `scenario` + stage knobs.

```bash
# Web stack (Colyseus server; three + babylon share THIS server, so server-side
# numbers are identical — see §8.1). engine label defaults to "three".
cd net/server && npm install
SCENARIO=n2-stress-ramp    BOTS=2,24,100    CLIENTS=2 SEED=12345 WARMUP_MS=500 MEASURE_MS=1500 OUT=web-stress.jsonl    npm run scenario
SCENARIO=n2-tickrate-sweep TICKS=10,15,20,30 BOT_COUNT=24 CLIENTS=2 SEED=12345 WARMUP_MS=500 MEASURE_MS=1500 OUT=web-tickrate.jsonl npm run scenario
SCENARIO=n2-latency-sweep  BOT_COUNT=24      CLIENTS=2 SEED=12345 WARMUP_MS=500 MEASURE_MS=1500 OUT=web-latency.jsonl   npm run scenario
# WAN-profile sweep (#159, §8.8): also writes a scenario-manifest.json with the jitter knobs.
SCENARIO=n2-wan-profile-sweep BOT_COUNT=24   CLIENTS=2 SEED=12345 WARMUP_MS=500 MEASURE_MS=1500 OUT=../measurements/n2/web-wan.jsonl MANIFEST=../measurements/n2/web-scenario-manifest.json npm run scenario

# Bevy native stack (replicon/renet). Shared cargo cache avoids a cold rebuild.
cd net/bevy && export CARGO_TARGET_DIR=/abs/shared/target
SCENARIO=n2-stress-ramp    BOTS=2,24,100    CLIENTS=2 SEED=12345 WARMUP_MS=500 MEASURE_MS=1500 OUT=bevy-stress.jsonl    cargo run -- --scenario
SCENARIO=n2-tickrate-sweep TICKS=10,15,20,30 BOT_COUNT=24 CLIENTS=2 SEED=12345 WARMUP_MS=500 MEASURE_MS=1500 OUT=bevy-tickrate.jsonl cargo run -- --scenario
SCENARIO=n2-latency-sweep  BOT_COUNT=24      CLIENTS=2 SEED=12345 WARMUP_MS=500 MEASURE_MS=1500 OUT=bevy-latency.jsonl  cargo run -- --scenario
SCENARIO=n2-wan-profile-sweep BOT_COUNT=24   CLIENTS=2 SEED=12345 WARMUP_MS=500 MEASURE_MS=1500 OUT=../measurements/n2/bevy-wan.jsonl MANIFEST=../measurements/n2/bevy-scenario-manifest.json cargo run -- --scenario
```

## WAN-profile sweep sidecar (`{web,bevy}-wan.jsonl` + `*-scenario-manifest.json`, #159)

`web-wan.jsonl` / `bevy-wan.jsonl` are the `n2-wan-profile-sweep` runs (clean →
good-wifi → 4g-mobile → transcontinental) behind COMPARISON §8.8. The thin
`MetricsSample` stays unchanged — base delay/loss are in `injectedDelay*` / `lossPct`,
but the **jitter sigma / distribution / correlation** live in a
`{web,bevy}-scenario-manifest.json` **sidecar** (one entry per profile). Join a metrics
line to its profile on `scenario` + `injectedDelay*` + `lossPct`. The jitter sampler is
shared + parity-pinned (`net/protocol/src/jitter.ts` ↔ `net/bevy/src/jitter.rs` via
`jitterFixtures.json`); reorder is emergent (faithful UDP on Bevy, approximate on web —
see each manifest's `reorderNote`).

## Read the parity notes before diffing

Some fields are TRUE apples-to-apples (`serverTickSimMs`, `injectedDelay*`,
`lossPct`); others carry a **documented measurement-basis gap** and must NOT be
cross-compared naively (`bytesUp/DownPerSec` = JSON vs postcard, `transportBytesPerSec`
= web estimate vs real renet wire, `rttP*Ms` = web app-echo includes injected delay
but Bevy transport RTT does not). The full gap table is in `net/bevy/CLAUDE.md`
→ "Honest-parity", summarized in COMPARISON.md §8.2. **Single-machine / localhost;
not a WAN or viral-scale benchmark.**

## Client-render sidecar (`*-client-render.jsonl`, #165 contract)

`web-three-client-render.jsonl` (#166) and `web-babylon-client-render.jsonl` (#167)
hold **per-client render performance** (fps + frame-time p50/p95) under net load —
one `ClientRenderSample` (`net/protocol/src/clientRender.ts`) per measurement
window. They are **sidecars**, not `MetricsSample` rows: each LEFT JOINs onto the
server `metrics.jsonl` above on the shared join keys (`scenario` / `engine` /
`seed` / `tickRate` / `botCount` + impairment knobs). `measurementBasis` is
`web-raf-dt` (web rAF deltas; a §8.2 parity gap vs Bevy frame diagnostics — do NOT
cross-compare magnitudes).

**three vs babylon here is a REAL comparison, not a copy.** Server-side metrics are
identical because three and babylon share one Colyseus server (§8.1), but **render**
perf is per-engine — the two `*-client-render.jsonl` files are independent
measurements of the SAME scenario/seed/tick under the SAME bot load. Both probes
sample RAW per-frame rAF deltas through the shared #165 sampler (three feeds rAF
`now`; babylon reads `performance.now()` per `runRenderLoop` frame — never the
smoothed `engine.getFps()` EMA), so their magnitudes are directly comparable.

**HONEST CAVEAT — this committed run is a headless software-WebGL smoke**, not a
real-GPU result. Headless Chromium renders WebGL through SwiftShader, so the
absolute `clientFps` / frame-time magnitudes are software-rendered. The pipeline
and sample SHAPE are faithful; the magnitudes are not. For real-GPU numbers,
follow the **manual** procedure in `net/web-three/README.md` → "Client-render probe".

**`clientCount:1` is structural, not a smoke artifact.** A client-render probe
connects exactly ONE real rendering client (plus the server's bot-driven load), so
`clientCount=1` holds for the real-GPU manual path too — it does NOT reproduce the
2-client server stage (`web-stress.jsonl` `n2-stress-ramp` has `clientCount:2`).
That is why `clientCount` is deliberately omitted from the join key list above:
join on `scenario` / `engine` / `seed` / `tickRate` / `botCount` + impairment knobs
only. Mind also the ~1-entity rendered-load delta (1+bots here vs 2+bots there).

```bash
# Server: a loaded n2-stress-ramp stage (24 bots), same seed/tick as web-stress.jsonl.
cd net/server && BOT_COUNT=24 SEED=12345 TICK=20 SCENARIO=n2-stress-ramp PORT=2567 \
  npm run dev:server:loaded
# Client: build + preview, then harvest via the Playwright smoke (software-WebGL).
cd net/web-three && npm run build && npx vite preview --port 4173 &
cd net/web-three && npm i -D playwright   # one-off; NOT a package.json dep
PREVIEW_URL=http://localhost:4173 \
  PROBE_QUERY='?probe=1&scenario=n2-stress-ramp&seed=12345&tickRate=20&botCount=24&clientCount=1&delayCtoSMs=0&delayStoCMs=0&lossPct=0&warmupMs=2000&windowDurationMs=4000&maxWindows=3' \
  RENDER_OUT=../measurements/n2/web-three-client-render.jsonl \
  npm run smoke:render

# Babylon sidecar (#167): SAME loaded server, SAME join keys — swap the client dir.
# `RENDER_OUT` (not OUT) keeps the client sidecar separate from the server's OUT.
cd net/web-babylon && npm run build && npx vite preview --port 4173 &
cd net/web-babylon && npm i -D playwright   # one-off; NOT a package.json dep
PREVIEW_URL=http://localhost:4173 \
  RENDER_OUT=../measurements/n2/web-babylon-client-render.jsonl \
  npm run smoke:render   # default PROBE_QUERY already matches the committed window params
```

Both committed sidecars are **headless software-WebGL smokes** (SwiftShader),
labelled as such above; for honest magnitudes replace either with a real-GPU
attended run (next section).

#### Two layers: `software` smoke vs `real-GPU` attended (#191)

The web client-render sidecars come in **two explicit layers** — do not confuse
their magnitudes:

| Layer | Renderer | Magnitudes | How / where |
|-------|----------|-----------|-------------|
| **software smoke** | headless Chromium → **SwiftShader** (software) | **NOT real GPU** | `npm run smoke:render` above; committed `web-{three,babylon}-client-render.jsonl` (the tables in COMPARISON §8.7 are explicitly software-WebGL) |
| **real-GPU attended** | **headed Chrome**, real display | real GPU (verified non-SwiftShader) | `node net/tools/realGpuRender.mjs` → `web-{three,babylon}-client-render.realgpu.jsonl` + `.meta.json` |

The committed `*-client-render.jsonl` files (no `.realgpu.` infix) are the
**software** layer — they exist to prove the pipeline emits well-formed, same-shape
samples, NOT to report a real-GPU verdict.

The **real-GPU** layer is produced by the CDP runner `net/tools/realGpuRender.mjs`
(#191): it spawns the loaded server, builds + `vite preview`s the client, launches
a **headed Chrome** (`headless:false`, SwiftShader NOT forced → real GPU), reuses
the **exact** `?probe=1...` join-key query the server prints, harvests
`window.__clientRenderSamples` over CDP, records `UNMASKED_RENDERER_WEBGL` in a
companion `.meta.json` (so non-SwiftShader is verifiable), and kills every spawned
process. It **aborts without writing** if the live renderer is SwiftShader/software.

```bash
# ATTENDED — on a real machine, with the launched Chrome window kept FOREGROUND.
ENGINE=three   node net/tools/realGpuRender.mjs   # one run per bot stage:
ENGINE=babylon node net/tools/realGpuRender.mjs   #   BOT_COUNT=2, then 24, then 100
# Procedure: join keys (scenario/engine/seed/tickRate/botCount) come from the
# server; clientCount=1 (one real renderer); window is vsync-capped so frame-time
# p50/p95 is primary and fps is a ceiling; per-frame GPU time < ~8.3 ms is invisible
# to rAF; allow a thermal cooldown between stages. Full procedure: net/tools/README.md.
```

**Why real-GPU is NOT on CI / not headless:** headless = SwiftShader (software, not
trustworthy), rAF throttles when the window is occluded, and vsync hides sub-8.3 ms
GPU time — so a trustworthy real-GPU number requires an **attended** run (real
display, foreground window, thermal cooldown). The CI/local gate stays **build +
typecheck + schema** only; real-GPU magnitudes are deliberately off CI (#191).

### Bevy native sidecar (`bevy-client-render.jsonl`, #168)

The native equivalent: the windowed Bevy client's render perf (frame-time p50/p95
+ fps) under bot load, same #165 `ClientRenderSample` shape, with `engine="bevy"`
and `measurementBasis="bevy-frame-diagnostics"` (RAW `FRAME_TIME` diagnostics, NOT
a smoothed fps). It LEFT JOINs onto the bevy `metrics.jsonl` on the same keys.

**No `bevy-client-render.jsonl` is committed here — by design, not omission.** The
Bevy probe needs a real GPU window; this repo's CI/agent environment has none, and
a headless `MinimalPlugins` run would time the `ScheduleRunner` loop rather than
real render frames — committing that would be a faked magnitude (Core Value #1).
The sampler + cross-language parity are headless-tested instead (`cd net/bevy &&
cargo test`; the shared fixture `net/protocol/src/clientRenderFixtures.json` keeps
the Rust and TS samplers numerically identical). Produce the honest sidecar with a
real-GPU manual run:

```bash
# Terminal 1 — loaded authority (24 bots, same seed/tick as bevy-stress.jsonl):
cd net/bevy && BOT_COUNT=24 SEED=12345 TICK=20 cargo run -- --server-loaded
# Terminal 2 — windowed probe client (RENDER_OUT, not OUT):
cd net/bevy && RENDER_PROBE=1 SCENARIO=n2-stress-ramp SEED=12345 TICK=20 BOT_COUNT=24 \
  WARMUP_MS=2000 WINDOW_MS=4000 MAX_WINDOWS=3 \
  RENDER_OUT=../measurements/n2/bevy-client-render.jsonl cargo run -- --client
```

**Web-vs-bevy magnitudes are NOT cross-comparable** (browser rAF vs native
window/GPU — a §8.2 parity gap); only the SHAPE under bot load is. Because the
window is typically **vsync-capped**, frame-time p50/p95 is the PRIMARY metric and
fps is a ceiling indicator. Full caveats: `net/bevy/CLAUDE.md` → "Client-render
probe (#168)".
