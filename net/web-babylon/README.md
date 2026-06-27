# net/web-babylon — N1 Babylon.js networking client

The second **client** of the networking chapter (`net/`). A thin Babylon.js
client that connects to the **same** Colyseus authority (`net/server`, #141) as
`net/web-three`, renders all players from authoritative snapshots with
**interpolation**, and sends input.

It is the sibling of `net/web-three`: both piggyback on the **same server** and
consume the **same `net/protocol` DTOs**. In fact the netcode modules
(`net/netClient.ts`, `net/snapshotBuffer.ts`, `net/input.ts`, `hud.ts`) are
**byte-for-byte identical** to web-three — only `main.ts` and `render/*` differ.
That is the point: the comparison stays a *render-engine* comparison, not a
netcode rewrite, so three and babylon clients are mutually visible in the same
room.

## What it demonstrates

- **Server-authoritative + client-interpolation** on the web side, in Babylon.js.
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
cd net/web-babylon && npm install && npm run dev      # open the printed URL (:5175)
```

Open the URL in **two browser tabs** to see a second player interpolate. Press
`SPACE` in one tab and watch its body light up in the other (the `FLAG_FIRING`
bit round-tripping through the authoritative snapshot).

**Cross-client check:** run `net/web-three` (`:5174`) and `net/web-babylon`
(`:5175`) against the same server at once — each client sees the other's player
move and fire, because both consume the identical authoritative snapshots.

To scale entity count without extra tabs, start the server with bots:
`BOTS=8 npm run dev:server`. Point at a non-default server with
`VITE_NET_SERVER=ws://host:port`.

### Build (must stay green)

```bash
cd net/web-babylon && npm run build    # tsc --noEmit && vite build
npm test                               # vitest — pure interpolation + input tests
```

## Controls

| Input | Action |
|-------|--------|
| `W`/`A`/`S`/`D` or arrows | Move (sent to server; the server moves you) |
| `SPACE` | Fire flag (sets `FLAG_FIRING` on your authoritative snapshot) |

## How it works

Identical to web-three on the wire (see that README for the netcode detail):

- `net/netClient.ts` — the only networked module. Joins the room, feeds
  `SnapshotMessage` frames into the interpolation buffer, sends `PlayerInput`
  (monotonic `seq` + client timestamp), and derives **RTT** from the echoed
  `seq` — no cross-machine wall-clock subtraction.
- `net/snapshotBuffer.ts` — pure, render-agnostic. Blends the two bracketing
  frames at a target **server** time; clamps at both ends (no extrapolation).
  Headless-tested in `snapshotBuffer.test.ts`.
- `render/players.ts` — diffs the interpolated entity set onto Babylon meshes
  (spawn / update / remove), disposing GPU resources for departed players.

### Interpolation & the clock

The server stamps each snapshot with its monotonic `serverTimeMs`. The client
anchors the two clocks once, from `WelcomeMessage.serverTimeMs`, then renders
`INTERP_TICKS` (2) ticks behind the estimated server-now so it always has two
frames to blend.

## Babylon.js notes (the engine difference, absorbed)

- **Left-handed by default.** We keep Babylon's native left-handed system rather
  than forcing `useRightHandedSystem` — the issue asks to *absorb* the engine
  difference, not hide it. Babylon's `Matrix.RotationY(θ)` maps local `+x` to
  `(cos θ, 0, −sin θ)`, so the mesh uses `rotation.y = −yaw` to point the nose
  along motion — coincidentally the same formula web-three uses, because both
  conventions map local `+x` the same way.
- **Camera.** A fixed angled-overhead `ArcRotateCamera` frames the whole arena
  (no `attachControl`, so dragging never fights the keyboard). web-three uses a
  static `PerspectiveCamera` for the same framing; the Babylon idiom is
  `ArcRotateCamera.setPosition`. (`FollowCamera` was considered, but following
  the local player would hide remote players — the wrong trade for an N1
  *mutual-visibility* sample.)
- **fps** comes from Babylon's built-in `engine.getFps()` smoothed estimate
  rather than a hand-rolled EMA.
- Snapshot positions are planar (`y = 0`); capsules are lifted by half their
  height to stand on the grid.

## Feel & honest notes

- **Interpolation delay is real and visible** (~100 ms behind at 20 Hz + 2 ticks
  of buffer). That is the price of jitter-free motion with no prediction; the
  local player feels the same lag because it is *also* rendered from
  authoritative snapshots (by design — low twitch). Identical to web-three.
- **The clock anchor folds in one-way latency** (single `WelcomeMessage`), so the
  offset is biased by the welcome's downstream latency. Fine for relative
  interpolation; it is not a synchronized clock.
- The reproducible measurement numbers live in the server's `metrics.jsonl`;
  this HUD is for real-machine confirmation only (net/CLAUDE.md).

## Scope (Won't Do here)

- No client-side prediction / reconciliation (N1 is low-twitch by design).
- No protocol fork — consumes `net/protocol` DTOs as-is; no babylon-specific
  server or room (piggybacks the shared "game" room).
- No Havok / physics — an N1 networking client renders authoritative poses; it
  does not simulate.
- Browser render verification is a manual / Playwright smoke (connect → self
  visible); the netcode logic is covered by the server's tests + the pure
  interpolation/input tests here.
