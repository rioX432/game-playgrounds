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
