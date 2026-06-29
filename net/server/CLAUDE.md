# net/server — Colyseus authoritative server (headless)

The web authority for the networking chapter. Both `three` and `babylon` clients
piggyback on THIS one server (see `../CLAUDE.md`). Headless: no rendering, ever.

## Commands

```bash
cd net/server
npm install
npm run typecheck   # tsc --noEmit — must stay green
npm test            # vitest (unit + in-process integration)
npm run scenario    # headless measurement run -> metrics.jsonl (env-configured)
npm run dev:server  # standalone Colyseus + WS transport on PORT (default 2567)
```

### N2 load probe (#144)

`npm run scenario` runs a **named** scenario (`src/scenarios/`), emitting ONE
`MetricsSample` line per stage to `metrics.jsonl`. Pick with `SCENARIO`:

| `SCENARIO` | What it sweeps | Rooms |
|------------|----------------|-------|
| `n2-stress-ramp` (default) | sync-entity count `BOTS=2,8,16,24,50,100` at fixed tick / zero impairment | one room, live bot ramp |
| `n2-tickrate-sweep` | `TICKS=10,15,20,30` at fixed `BOT_COUNT` (optimum search) | fresh room per tick |
| `n2-latency-sweep` | bidirectional delay+loss points at fixed `BOT_COUNT` | fresh room per point |
| `n2-wan-profile-sweep` | named WAN profiles (clean/good-wifi/4g-mobile/transcontinental) at fixed `BOT_COUNT` — base delay+loss **and jitter** (#159) | fresh room per profile |
| `adhoc` | single-shim bot ramp from `DELAY_*` / `LOSS_*` env (the #141 run) | one room, live bot ramp |

Env knobs (all optional): `SCENARIO ENGINE SEED OUT WARMUP_MS MEASURE_MS
CLIENTS TICK BOTS BOT_COUNT TICKS DELAY_UP_MS DELAY_DOWN_MS LOSS_UP_PCT
LOSS_DOWN_PCT`. Each stage settles for `WARMUP_MS` (window discarded), then the
`MEASURE_MS` window becomes the sample. `BOTS`/`TICKS` accept comma ramps. The
in-process runner (`runScenario`) is also called directly by the Vitest tests.

Example:
`SCENARIO=n2-stress-ramp BOTS=2,24,100 CLIENTS=2 WARMUP_MS=300 MEASURE_MS=700 OUT=metrics.jsonl npm run scenario`

Room-boot strategy: `tickRate` and `shim` (delay + loss + **jitter**) are fixed at
`onCreate`, so the runner boots a fresh room whenever those (or `clientCount`)
change and live-ramps `botCount` within a segment. A finished room is drained to
zero bots (not force-disconnected — that resets the in-process test client's
keep-alive socket) and idles until the scenario's single shutdown.

### WAN profiles + jitter (#159)

`n2-wan-profile-sweep` applies the shared `WAN_PROFILES` (`net-protocol`) — base
delay + loss **and per-delivery jitter** (the `TransportShim` draws from the shared
`JitterSampler`; reorder emerges from variable delay, only an APPROXIMATION on
Colyseus's reliable-ordered channel). The thin `MetricsSample` is unchanged: the
jitter sigma/distribution/correlation are written to a `scenario-manifest.json`
sidecar (path via `MANIFEST`, else next to `OUT`), joined on `scenario` +
`injectedDelay*` + `lossPct`. See COMPARISON §8.8.

## Version pins (verified at impl time — do NOT float)

- **`colyseus@0.16.3`** and **`@colyseus/testing@0.16.3`** — pinned EXACT, no `^`.
  Rationale: the issue/chapter target the **0.16 series**. npm's `latest` is the
  0.17 line and `next` is 0.18 — a floating range would silently pull a major
  bump. The `colyseus` 0.16 line tops at `0.16.5` but `@colyseus/testing` tops at
  `0.16.3`; both are pinned to **0.16.3** so `@colyseus/core` is not duplicated
  between the server and the test harness (duplication breaks Schema/`instanceof`).

## Architecture (the netcode pattern, kept thin)

- **`net/protocol`** owns the wire DTOs (`PlayerSnapshot { id, pos, yaw, flags,
  seq }`, `PlayerInput`, `SnapshotMessage`, `WelcomeMessage`). Imported, never
  redefined. Resist widening — a fat snapshot turns this into a
  Colyseus-adaptation comparison.
- **No `@colyseus/schema` auto-sync.** The room broadcasts our OWN snapshot
  frames each tick (Codex-verified, #141). We use Colyseus for room lifecycle,
  transport, and message routing only. This (a) mirrors what `bevy_replicon` will
  do, (b) makes application bytes directly measurable, (c) avoids coupling
  measurement to Colyseus's opaque delta encoding.
- **`World`** (`src/sim/`) is pure, transport-free authoritative simulation —
  headless-testable, the exact shape the Bevy authority mirrors.
- **Bots vs probes.** Server-side `BotDriver` adds simulated players as pure
  server-internal entities (no socket) to scale entity count 2→24→100+. Only real
  connected clients are RTT/snapshot-age **probes** (they close the round trip the
  server cannot). `clientCount` = connected, `botCount` = server bots.
- **`TransportShim`** injects latency/loss SEPARATELY for up (client→server) and
  down (server→client), at the APPLICATION layer on top of Colyseus's reliable
  channel. It is isolated behind our own type so the Bevy side can mirror it.

## Measurement caveats (honest-feel notes — bake into any analysis)

- `bytesUp/DownPerSec` are **application payload** (`JSON.stringify` byte length),
  NOT actual TCP/WS wire bytes. `transportBytesPerSec` adds a constant
  `FRAMING_OVERHEAD_BYTES` per message as an estimate — still not measured wire
  bytes. This is intentional (see Codex caveat in the PR / #141).
- The loss shim is **application-level impairment** (a dropped snapshot/input),
  NOT UDP transport loss: no retransmit pressure, congestion, or TCP
  head-of-line-blocking modelling.
- The schema's single `lossPct` records `max(up, down)` loss; the shim injects
  up/down loss independently, and recording the max guarantees an asymmetric run
  never under-reports its impairment. Splitting the field into two is a deliberate
  schema-rev (out of scope for #141).
- `serverTickSendMs` is only meaningful at **zero down-delay**. With `down.delayMs
  > 0` the shim defers the real `client.send()` into a `setTimeout`, so the
  measured send window captures only scheduling cost, not the actual flush. Do not
  compare `serverTickSendMs` across scenarios that differ in injected down-delay.
- In-process tests share one monotonic clock between client and server, so
  `snapshotAgeMs` and RTT are exact. Cross-machine clock-offset handling is a
  client-sample concern (the three/babylon client issues).

## Test runner gotcha

Vitest runs with **`pool: 'threads'`** (see `vitest.config.ts`). The default
`forks` pool uses a child_process IPC channel that collides with Colyseus's
process-level messaging and corrupts vitest's worker RPC (`Buffer.from(Object)`
crash). worker_threads use a private MessageChannel — no collision.

## Language

- Code comments & identifiers: English. Commits: concise single line, English.
