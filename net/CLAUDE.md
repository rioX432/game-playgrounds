# net/ — networking chapter

The second chapter of game-playgrounds. The first chapter compared single-machine
mechanics across three render engines (see `../COMPARISON.md`). This chapter asks a
different question: **how do you implement multiplayer, and how does each engine
behave under network load?** The goal is **implementation patterns + performance
characteristics**, not reproducing any specific game.

## What this chapter establishes

- A reusable **server-authoritative + client-interpolation** pattern.
- Honest **measurement** of bandwidth, RTT, snapshot age, and server tick budget
  across engines and network conditions.

## Stack

| Piece | Choice | Why |
|-------|--------|-----|
| Shared contracts | `net/protocol` (TypeScript) | Transport-agnostic types shared by web clients + measurement tooling. |
| Web server / authority | **Colyseus** (piggyback) | Mature room/state-sync server; we ride on it rather than hand-roll a netcode stack. |
| Web clients | three / babylon (existing TS playgrounds) | Reuse the engines already compared. |
| Native authority + client | **Bevy 0.18 + bevy_replicon (0.40 line)** | Idiomatic Rust server-authoritative replication, mirrors the web pattern. |

### Version pins

- **Bevy `0.18`** — same pin as `../bevy`. LLM training data is full of older Bevy
  APIs that will not compile; use 0.18 only.
- **bevy_replicon — 0.40 line (CONFIRMED, #145).** The dependency spike verified the
  exact 0.18-compatible pins against the crates.io sparse index (the published `bevy`
  dependency range each version declares): `bevy_replicon =0.40.4` (`bevy ^0.18`) +
  `bevy_replicon_renet =0.16.0` (`bevy ^0.18.0`, `bevy_renet ^4.0`). `bevy_replicon`
  0.41 / `bevy_replicon_renet` 0.17 both jump to Bevy 0.19, so the pins are EXACT `=`
  (no caret). `net/bevy/Cargo.toml` + `net/bevy/CLAUDE.md` are the binding source of
  truth (with crates.io evidence); re-verify the ranges on any Bevy bump.

### Colyseus piggyback policy

We **piggyback** on Colyseus for the web side — use it for rooms, transport, and
state sync, but keep our own logic thin on top. Codex warning baked in: do **not**
let the schema or sample design drift into "adapting to Colyseus". The comparison
is about engines and netcode patterns, not about Colyseus integration depth. If a
measurement needs a Colyseus-specific hook, isolate it behind our own type so the
Bevy/replicon side can mirror it.

## metrics.jsonl convention

All measurement output is **JSON Lines**: one `MetricsSample`
(`net/protocol/src/metrics.ts`) per line, append-only.

- One line = one measurement point. No arrays-of-samples, no nesting.
- Every engine emits the **same** shape — that is the whole point; cross-engine
  diffs must be apples-to-apples.
- **Units live in field names**: `*Ms`, `*PerSec`, `*Pct`. Keep that convention
  for any future field so a line reads without a legend.
- The schema is **thin on purpose**. Adding an axis is a deliberate schema-rev,
  not a casual field add — a fat schema degrades the render-engine comparison into
  a transport-adaptation comparison.
- RTT is measured from a **client monotonic timestamp echoed back with a seq**, not
  wall-clock subtraction across machines.
- The single `lossPct` field records `max(up, down)` when a transport injects loss
  asymmetrically, so an asymmetric run never under-reports its impairment.
- `serverTickSendMs` is only meaningful when send is **not** deferred by an injected
  send-side delay (see `net/server/CLAUDE.md`).
- The **shape** is identical across engines, but some field VALUES are measured
  differently where a stack cannot mirror the other (Core Value #1 — documented, not
  faked). For Bevy specifically: `bytesUp/DownPerSec` are app payload in **postcard**
  (vs web JSON), `transportBytesPerSec` is **real renet wire bytes** (vs a web
  estimate), and `rttP50/P95Ms` is **renet transport RTT** that does NOT include
  app-injected delay. Full table in `net/bevy/CLAUDE.md` → "Honest-parity". Read it
  before cross-engine diffing (#148).
- **Client-render metrics live in a SEPARATE sidecar, by deliberate design.** Client
  fps / frame-time (p50/p95) are NOT fields on `MetricsSample`; they are recorded in
  their own `client-render.jsonl` file as `ClientRenderSample`
  (`net/protocol/src/clientRender.ts`, #165), one line per per-client measurement
  window. The server `MetricsSample` stays thin. Rationale: web fps is sampled from
  `requestAnimationFrame` deltas while Bevy fps comes from frame-time diagnostics —
  a §8.2 parity gap (see `COMPARISON.md`), so they are not a directly-comparable
  "client truth" to fold onto every server line. The sidecar carries the same join
  keys (`scenario` / `engine` / `seed` / `tickRate` / `clientCount` / `botCount` +
  impairment knobs) so it LEFT JOINs onto `metrics.jsonl` without pretending to be
  one. The shared pure sampler `aggregateRenderWindow` (frame deltas → fps + p50/p95)
  is unit-tested headless; the per-engine probes (#166/#167/#168) reuse it.
- **WAN-profile jitter knobs live in a SEPARATE sidecar too (#159).** The
  `n2-wan-profile-sweep` adds delay **jitter** + emergent reorder via named WAN
  profiles (`net/protocol/src/wanProfiles.ts`). The base delay/loss still ride the
  existing `injectedDelay*` / `lossPct` fields, but the jitter **sigma /
  distribution / correlation** are INPUT knobs (constant per profile, not per-tick
  outputs), so — same thin-schema discipline as the client-render sidecar — they go
  in a `scenario-manifest.json` sidecar (`ScenarioManifest`,
  `net/protocol/src/scenarioManifest.ts`), joined on `scenario` + `injectedDelay*` +
  `lossPct`. The `MetricsSample` is UNCHANGED (#148 diff + the Bevy 18-field pin test
  stay green). The jitter sampler is shared + parity-pinned (`jitter.ts` ↔
  `net/bevy/src/jitter.rs` via `jitterFixtures.json`). See COMPARISON §8.8.

## Subprojects

| Dir | Stack | Status |
|-----|-------|--------|
| `protocol/` | TypeScript shared types (measurement schema + wire DTOs) | locked schema (#140) + thin DTOs (#141); `ClientRenderSample` sidecar contract + shared pure `aggregateRenderWindow` sampler (#165) |
| `server/` | TypeScript + Colyseus `0.16.3` authoritative room (headless) | bot driver + transport shim + metrics.jsonl (#141); N2 load-probe scenarios — sync-count ramp + bidirectional shim sweep + tick-rate sweep (#144) |
| `web-three/` | TypeScript + Three.js + `colyseus.js 0.16.3` N1 client (render/input/interp) | room + position sync + interpolation + HUD (#142); client-render probe — `?probe=1` rAF sidecar emitting `ClientRenderSample` via the shared `aggregateRenderWindow` sampler (#166) |
| `web-babylon/` | TypeScript + Babylon.js + `colyseus.js 0.16.3` N1 client (render/input/interp) | same server/room as web-three; identical netcode, Babylon render only (#143); client-render probe — `?probe=1` render-loop sidecar emitting `ClientRenderSample` via the same `aggregateRenderWindow` sampler (#167) |
| `bevy/` | Rust + Bevy `0.18.1` + `bevy_replicon 0.40.4` / `bevy_replicon_renet 0.16.0` native authority+client | dependency spike — `cargo check` green + minimal plugin skeleton (#145); N1 server-authoritative replication + client interpolation, render/net-sim split, real-UDP loopback test (#146); N2 load probe — bot ramp + app-level bidirectional conditioner + `metrics.jsonl` in the #140 schema, with documented honest-parity gaps vs the web probe (#147); client-render probe — windowed `--client` probe emitting `ClientRenderSample` via the same `aggregateRenderWindow` sampler (#168) |

> Build: `cd net/protocol && npm install && npm run typecheck && npm test` (must stay green).
> Build: `cd net/server && npm install && npm run typecheck && npm test` (must stay green).
> Build: `cd net/web-three && npm install && npm run build && npm test` (must stay green).
> Build: `cd net/web-babylon && npm install && npm run build && npm test` (must stay green).
> Build: `cd net/bevy && cargo check` (must stay green; Bevy 0.18 ONLY — see `net/bevy/CLAUDE.md`).
> This chapter has its **own** web clients (`web-three`, `web-babylon`) and does
> **not** touch the `../three`, `../babylon`, or `../bevy` builds. The two web
> clients piggyback the **same** server + room ("game"); they differ ONLY in the
> render/input layer, so cross-client (three <-> babylon) mutual visibility holds.
>
> The client-render-under-load synthesis is `COMPARISON.md` §8.7 (#169); raw
> evidence (server `metrics.jsonl` + `*-client-render.jsonl` sidecars) and the
> web-on-steam Layer-2 host-overhead measurements live under `net/measurements/`.

### Colyseus version pin (caveat)

The chapter targets the **0.16 series**. At impl time npm's `latest` is the 0.17
line and `next` is 0.18, so a floating range would pull a major bump. Pinned
EXACT: **`colyseus@0.16.3` + `@colyseus/testing@0.16.3`** (testing's 0.16 line
tops at 0.16.3; matching both avoids `@colyseus/core` duplication). The server
crate's `package.json` is the binding source of truth — see `net/server/CLAUDE.md`.

## Language

- Code comments & identifiers: English.
- Commits: concise single line, English.
