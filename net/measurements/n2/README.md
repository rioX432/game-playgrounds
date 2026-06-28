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

# Bevy native stack (replicon/renet). Shared cargo cache avoids a cold rebuild.
cd net/bevy && export CARGO_TARGET_DIR=/abs/shared/target
SCENARIO=n2-stress-ramp    BOTS=2,24,100    CLIENTS=2 SEED=12345 WARMUP_MS=500 MEASURE_MS=1500 OUT=bevy-stress.jsonl    cargo run -- --scenario
SCENARIO=n2-tickrate-sweep TICKS=10,15,20,30 BOT_COUNT=24 CLIENTS=2 SEED=12345 WARMUP_MS=500 MEASURE_MS=1500 OUT=bevy-tickrate.jsonl cargo run -- --scenario
SCENARIO=n2-latency-sweep  BOT_COUNT=24      CLIENTS=2 SEED=12345 WARMUP_MS=500 MEASURE_MS=1500 OUT=bevy-latency.jsonl  cargo run -- --scenario
```

## Read the parity notes before diffing

Some fields are TRUE apples-to-apples (`serverTickSimMs`, `injectedDelay*`,
`lossPct`); others carry a **documented measurement-basis gap** and must NOT be
cross-compared naively (`bytesUp/DownPerSec` = JSON vs postcard, `transportBytesPerSec`
= web estimate vs real renet wire, `rttP*Ms` = web app-echo includes injected delay
but Bevy transport RTT does not). The full gap table is in `net/bevy/CLAUDE.md`
→ "Honest-parity", summarized in COMPARISON.md §8.2. **Single-machine / localhost;
not a WAN or viral-scale benchmark.**

## Client-render sidecar (`*-client-render.jsonl`, #165 contract)

`web-three-client-render.jsonl` holds **per-client render performance** (fps +
frame-time p50/p95) under net load — one `ClientRenderSample`
(`net/protocol/src/clientRender.ts`) per measurement window. It is a **sidecar**,
not a `MetricsSample` row: it LEFT JOINs onto the server `metrics.jsonl` above on
the shared join keys (`scenario` / `engine` / `seed` / `tickRate` / `botCount` +
impairment knobs). `measurementBasis` is `web-raf-dt` (web rAF deltas; a §8.2
parity gap vs Bevy frame diagnostics — do NOT cross-compare magnitudes).

**HONEST CAVEAT — this committed run is a headless software-WebGL smoke**, not a
real-GPU result. Headless Chromium renders WebGL through SwiftShader, so the
absolute `clientFps` / frame-time magnitudes are software-rendered (note the
`clientCount:1`, single headless renderer). The pipeline and sample SHAPE are
faithful; the magnitudes are not. For real-GPU numbers, follow the **manual**
procedure in `net/web-three/README.md` → "Client-render probe".

```bash
# Server: a loaded n2-stress-ramp stage (24 bots), same seed/tick as web-stress.jsonl.
cd net/server && BOT_COUNT=24 SEED=12345 TICK=20 SCENARIO=n2-stress-ramp PORT=2567 \
  npm run dev:server:loaded
# Client: build + preview, then harvest via the Playwright smoke (software-WebGL).
cd net/web-three && npm run build && npx vite preview --port 4173 &
cd net/web-three && npm i -D playwright   # one-off; NOT a package.json dep
PREVIEW_URL=http://localhost:4173 \
  PROBE_QUERY='?probe=1&scenario=n2-stress-ramp&seed=12345&tickRate=20&botCount=24&clientCount=1&delayCtoSMs=0&delayStoCMs=0&lossPct=0&warmupMs=2000&windowDurationMs=4000&maxWindows=3' \
  OUT=../measurements/n2/web-three-client-render.jsonl \
  npm run smoke:render
```
