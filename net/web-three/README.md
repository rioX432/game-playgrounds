# net/web-three — N1 Three.js networking client

The first **client** of the networking chapter (`net/`). A thin Three.js client
that connects to the shared Colyseus authority (`net/server`, #141), renders all
players from authoritative snapshots with **interpolation**, and sends input.

It is the sibling of the forthcoming `net/web-babylon` client: both piggyback on
the **same server** and consume the **same `net/protocol` DTOs**, so the
comparison stays a *render-engine* comparison, not a netcode rewrite.

## What it demonstrates

- **Server-authoritative + client-interpolation** on the web side.
- The client owns **render + input + interpolation only** — no authoritative
  simulation, no client-side prediction (this sample is deliberately low-twitch).
- Minimal authoritative state echoed to the screen: positions, facing yaw, and
  the `FLAG_FIRING` boolean (the "tag / role flag") highlighted on the body.
- Honest client-side telemetry: synced count, RTT, snapshot age, fps.

## Run

The client needs the server running first:

```bash
# 1. start the authoritative server (separate terminal)
cd net/server && npm install && npm run dev:server   # ws://localhost:2567

# 2. start the client
cd net/web-three && npm install && npm run dev        # open the printed URL
```

Open the URL in **two browser tabs** to see a second player interpolate. Press
`SPACE` in one tab and watch its body light up in the other (the `FLAG_FIRING`
bit round-tripping through the authoritative snapshot). To scale entity count
without extra tabs, start the server with bots: `BOTS=8 npm run dev:server`.

Point at a non-default server with `VITE_NET_SERVER=ws://host:port`.

### Build (must stay green)

```bash
cd net/web-three && npm run build    # tsc --noEmit && vite build
npm test                             # vitest — pure interpolation-buffer tests
```

## Controls

| Input | Action |
|-------|--------|
| `W`/`A`/`S`/`D` or arrows | Move (sent to server; the server moves you) |
| `SPACE` | Fire flag (sets `FLAG_FIRING` on your authoritative snapshot) |

## How it works

- `net/netClient.ts` — the only networked module. Joins the room, feeds
  `SnapshotMessage` frames into the interpolation buffer, sends `PlayerInput`
  (with a monotonic `seq` + client timestamp), and derives **RTT** from the
  echoed `seq` — exactly as the server-side probe does, so no cross-machine
  wall-clock subtraction is involved.
- `net/snapshotBuffer.ts` — pure, render-agnostic. Holds recent frames and
  blends the two bracketing them at a target **server** time. Clamps at both
  ends (no extrapolation). Headless-tested in `snapshotBuffer.test.ts`.
- `render/players.ts` — diffs the interpolated entity set onto meshes (spawn /
  update / remove), disposing GPU resources for departed players.

### Interpolation & the clock

The server stamps each snapshot with its monotonic `serverTimeMs`, whose origin
is arbitrary relative to the browser clock. The client anchors the two clocks
once, from `WelcomeMessage.serverTimeMs`, then renders `INTERP_TICKS` (2) ticks
behind the estimated server-now so it always has two frames to blend.

## Feel & honest notes

- **Interpolation delay is real and visible.** At the default 20 Hz tick + 2
  ticks of buffer, remote players render ~100 ms in the past. That is the price
  of jitter-free motion with no prediction; the local player feels the same lag
  because it is *also* rendered from authoritative snapshots (by design — low
  twitch). A twitch game would add client-side prediction for the local player.
- **The clock anchor folds in one-way latency.** The offset is taken from a
  single `WelcomeMessage`, so the welcome's downstream latency biases the
  baseline. Fine for relative interpolation; it is not a synchronized clock.
- **`snapshot age` is the freshest frame's staleness** (estimated server-now −
  newest snapshot time ≈ down-path latency + tick quantization), distinct from
  the fixed interpolation delay. The reproducible numbers live in the server's
  `metrics.jsonl`; this HUD is for real-machine confirmation only.

## Three.js notes

- Server yaw is `atan2(moveZ, moveX)` in world x/z; Three rotates +x toward −z
  about +Y, so the mesh uses `rotation.y = -yaw` to point the nose along motion.
- Snapshot positions are planar (`y = 0`); capsules are lifted by half their
  height to stand on the grid.

## Client-render probe (#166) — render perf under net load

This client doubles as the **three.js render-under-load probe** for the chapter.
With `?probe=1` it collects RAW per-frame `requestAnimationFrame` deltas into
fixed wall-clock windows and, via the **shared #165 sampler**
(`net-protocol` → `aggregateRenderWindow`), emits one **`ClientRenderSample`**
per kept window into a sidecar `client-render.jsonl`. The HUD fps is an EMA for
display ONLY and is **never** fed to the sampler (Codex #165 rule).

The probe is OFF for ordinary play. Files: `src/render/renderProbe.ts`
(pure batching + sampler glue, headless-tested), `src/render/renderProbeConfig.ts`
(URL-param parsing, headless-tested), `src/render/probeGlobals.ts` (browser
harvest hooks).

### Join-key parameters (URL query)

The probe is **parameterized** so its sample join keys line up with a server
bot-ramp `metrics.jsonl` stage. All are query params on the page URL:

| Param | Meaning | Default |
|-------|---------|---------|
| `probe` | `1` enables the probe | (off) |
| `scenario` | join key, e.g. `n2-stress-ramp` | `n2-stress-ramp` |
| `seed` | RNG seed join key | `12345` |
| `tickRate` | server tick Hz join key | `20` |
| `botCount` | bot stage join key (`2`/`24`/`100`) | `24` |
| `clientCount` | connected real clients join key | `1` |
| `clientIndex` | which real client (0-based) | `0` |
| `delayCtoSMs` / `delayStoCMs` | injected one-way delay join keys | `0` |
| `lossPct` | injected loss join key (`max(up,down)`) | `0` |
| `warmupMs` | settling window excluded before measuring | `2000` |
| `windowDurationMs` | measurement window length | `5000` |
| `maxWindows` | stop after this many KEPT windows (`<=0` ⇒ forever) | `3` |

`engine` is fixed to `three` in code (not a param), so a three run can never be
mislabelled. `measurementBasis` is always `web-raf-dt`.

`warmup` excludes connection / scene-setup / first-snapshot / shader-compile
settling: it starts counting only once the client is connected AND a first
snapshot has arrived. Throttled windows (a `dt` above the contract's
`THROTTLE_MAX_MS`, i.e. a backgrounded-tab pause) and statistically-weak windows
(below `MIN_VALID_SAMPLES`) are dropped, never recorded.

### Driving load: the loaded server

`npm run dev:server` boots an EMPTY room (no bots), so a lone browser sees no
load. Use the thin loaded-room harness instead — it pre-creates ONE labelled
`game` room with bots via the standard matchmaker (`createRoom`), reusing the
#144 knobs. The client's netcode is **unchanged**; its plain `joinOrCreate("game")`
lands in the loaded room and renders `botCount + 1` entities.

```bash
cd net/server
BOT_COUNT=24 SEED=12345 TICK=20 SCENARIO=n2-stress-ramp PORT=2567 \
  npm run dev:server:loaded
# It prints the exact `?probe=1&...` query to use so the join keys match.
# Knobs mirror the scenario runner: BOT_COUNT, SEED, TICK, SCENARIO,
# DELAY_UP_MS, DELAY_DOWN_MS, LOSS_UP_PCT, LOSS_DOWN_PCT, OUT (optional metrics).
```

To sweep the ramp, run one stage at a time (`BOT_COUNT=2`, then `24`, then `100`)
and append each run's `client-render.jsonl` lines, mirroring the server's
`n2-stress-ramp` stages so the two files LEFT JOIN on the keys.

### Measurement mechanism

Two honest options — pick per your need:

**(a) Manual, real-GPU (the honest numbers).** Start the loaded server, then
`npm run dev`, open the printed dev URL **with the probe query** in a real
browser, and let it run. The page exposes `window.__clientRenderSamples` and a
`window.__downloadClientRenderJsonl()` helper (and `console.log`s each line as
`[client-render] {…}`). Call the download helper to save `client-render.jsonl`.
This uses your real GPU, so the fps/frame-time are representative.

**(b) Playwright smoke (auto, software-WebGL).** `smoke/renderProbe.smoke.mjs`
loads the built client headless against the loaded server, harvests
`window.__clientRenderSamples`, and writes `client-render.jsonl`. **Caveat:**
headless Chromium renders WebGL via SwiftShader (software), so the absolute
numbers are NOT a real-GPU result — the pipeline and sample SHAPE are faithful,
the magnitudes are not. Playwright is intentionally **not** a dependency (keeps
`npm install && npm run build && npm test` browser-free); install it once to run
the smoke:

```bash
cd net/server   && BOT_COUNT=24 SEED=12345 TICK=20 PORT=2567 npm run dev:server:loaded   # terminal 1
cd net/web-three && npm run build && npx vite preview --port 4173                          # terminal 2
cd net/web-three && npm i -D playwright                                                    # one-off
PREVIEW_URL=http://localhost:4173 \
  PROBE_QUERY='?probe=1&scenario=n2-stress-ramp&seed=12345&tickRate=20&botCount=24&clientCount=1&delayCtoSMs=0&delayStoCMs=0&lossPct=0&warmupMs=2000&windowDurationMs=4000&maxWindows=3' \
  RENDER_OUT=../measurements/n2/web-three-client-render.jsonl \
  npm run smoke:render
```

A sample headless-smoke run is committed at
`net/measurements/n2/web-three-client-render.jsonl` (labelled software-WebGL in
that dir's README — replace with a real-GPU manual run for honest magnitudes).

## Scope (Won't Do here)

- No client-side prediction / reconciliation (N1 is low-twitch by design).
- No protocol fork — consumes `net/protocol` DTOs as-is.
- Browser render verification is a manual / Playwright smoke (connect → self
  visible); the netcode logic is covered by the server's tests + the pure
  interpolation tests here.
