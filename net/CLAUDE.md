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
- **bevy_replicon — 0.40 line (TARGET).** replicon tracks Bevy releases closely;
  the exact 0.18-compatible release MUST be confirmed against crates.io at the time
  the Bevy server issue is implemented (do not assume — verify the published
  `bevy` dependency range of the chosen replicon version). This file records the
  intended pin; the server crate's `Cargo.toml` is the binding source of truth.

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

## Subprojects

| Dir | Stack | Status |
|-----|-------|--------|
| `protocol/` | TypeScript shared types (measurement schema + wire DTOs) | locked schema (#140) + thin DTOs (#141) |
| `server/` | TypeScript + Colyseus `0.16.3` authoritative room (headless) | bot driver + transport shim + metrics.jsonl (#141); N2 load-probe scenarios — sync-count ramp + bidirectional shim sweep + tick-rate sweep (#144) |
| `web-three/` | TypeScript + Three.js + `colyseus.js 0.16.3` N1 client (render/input/interp) | room + position sync + interpolation + HUD (#142) |
| `web-babylon/` | TypeScript + Babylon.js + `colyseus.js 0.16.3` N1 client (render/input/interp) | same server/room as web-three; identical netcode, Babylon render only (#143) |

> Build: `cd net/protocol && npm install && npm run typecheck` (must stay green).
> Build: `cd net/server && npm install && npm run typecheck && npm test` (must stay green).
> Build: `cd net/web-three && npm install && npm run build && npm test` (must stay green).
> Build: `cd net/web-babylon && npm install && npm run build && npm test` (must stay green).
> This chapter has its **own** web clients (`web-three`, `web-babylon`) and does
> **not** touch the `../three`, `../babylon`, or `../bevy` builds. The two web
> clients piggyback the **same** server + room ("game"); they differ ONLY in the
> render/input layer, so cross-client (three <-> babylon) mutual visibility holds.

### Colyseus version pin (caveat)

The chapter targets the **0.16 series**. At impl time npm's `latest` is the 0.17
line and `next` is 0.18, so a floating range would pull a major bump. Pinned
EXACT: **`colyseus@0.16.3` + `@colyseus/testing@0.16.3`** (testing's 0.16 line
tops at 0.16.3; matching both avoids `@colyseus/core` duplication). The server
crate's `package.json` is the binding source of truth — see `net/server/CLAUDE.md`.

## Language

- Code comments & identifiers: English.
- Commits: concise single line, English.
