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

## Scope (Won't Do here)

- No client-side prediction / reconciliation (N1 is low-twitch by design).
- No protocol fork — consumes `net/protocol` DTOs as-is.
- Browser render verification is a manual / Playwright smoke (connect → self
  visible); the netcode logic is covered by the server's tests + the pure
  interpolation tests here.
