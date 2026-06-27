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

Scenario env knobs (all optional):
`SCENARIO ENGINE SEED TICK BOTS CLIENTS INPUT_HZ DURATION_MS FLUSH_MS OUT
DELAY_UP_MS DELAY_DOWN_MS LOSS_UP_PCT LOSS_DOWN_PCT`. `BOTS` accepts a ramp,
e.g. `BOTS="2,24,100"` (each stage runs for `DURATION_MS`).

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
