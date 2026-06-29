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

- **Right-handed scene to match three's screen convention.** Babylon defaults to
  a *left-handed* system, which mirrors the X axis on screen: world `+x` projects
  to screen **left** instead of right. Placing players at literal server
  coordinates is not enough — the projection itself is mirrored, so a left-handed
  babylon client comes out a left-right mirror of three with inverted controls.
  Setting `scene.useRightHandedSystem = true` matches three's right-handed screen
  convention (world `+x` → screen right), which is what "absorbing the engine
  difference" actually means here. Verified numerically by projecting world
  points through each engine's real view×projection: `+x (5,0,0)` → `NDC.x =
  +0.181` in **both** three and babylon (left-handed babylon gave `−0.181`).
- **Yaw mapping.** `Matrix.RotationY(θ)` maps local `+x` to `(cos θ, 0, −sin θ)`
  independent of scene handedness, so the mesh uses `rotation.y = −yaw` to point
  the nose along motion — the same formula web-three uses, and (with the
  right-handed scene above) facing the same on-screen direction.
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

## Client-render probe (#167) — render perf under net load

This client doubles as the **Babylon.js render-under-load probe** for the chapter
— the sibling of the three.js probe (#166). With `?probe=1` it collects RAW
per-frame deltas into fixed wall-clock windows and, via the **shared #165 sampler**
(`net-protocol` → `aggregateRenderWindow`), emits one **`ClientRenderSample`**
per kept window into a sidecar `client-render.jsonl`.

**three ≠ babylon is the whole point.** Server-side metrics are shared (one
Colyseus server, so they were a "copy" for babylon — §8.1), but **render** perf is
per-engine: this probe is an INDEPENDENT measurement, not a copy of the three
numbers. It copies the three PROBE PATTERN, not the data.

### Where the raw dt comes from (the babylon delta)

Babylon's render loop is rAF-driven but its `runRenderLoop` callback receives no
timestamp, so `main.ts` reads `performance.now()` once per frame as the RAW frame
timestamp (the babylon analogue of three's rAF `now`) and feeds it to
`renderProbe.recordFrame(...)`. The probe derives its own raw per-frame delta from
those timestamps. Babylon's built-in `engine.getFps()` is a smoothed EMA used for
the HUD **display only** and is **never** fed to the sampler — feeding it would
smear the p95 tail (the babylon analogue of three's HUD-EMA trap, Codex #165 rule).
`engine` is fixed to `babylon` in code (not a param); `measurementBasis` is always
`web-raf-dt` (same basis as three — both are browser rAF deltas).

The probe is OFF for ordinary play. Files: `src/render/renderProbe.ts` (pure
batching + sampler glue, headless-tested), `src/render/renderProbeConfig.ts`
(URL-param parsing, headless-tested), `src/render/probeGlobals.ts` (browser
harvest hooks). They mirror `net/web-three/src/render/*` one-for-one.

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

`warmup` excludes connection / scene-setup / first-snapshot / shader-compile
settling: it starts counting only once the client is connected AND a first
snapshot has arrived. Throttled windows (a `dt` above the contract's
`THROTTLE_MAX_MS`, a backgrounded-tab pause) and statistically-weak windows
(below `MIN_VALID_SAMPLES`) are dropped, never recorded.

**`clientCount` is NOT a render-sample join key.** A probe connects exactly ONE
real rendering client, so `clientCount=1` is structural (it holds for a real-GPU
manual run too) and does NOT reproduce the 2-client server stage. Join the sidecar
onto `metrics.jsonl` on `scenario` / `engine` / `seed` / `tickRate` / `botCount` +
impairment knobs only; mind the ~1-entity rendered-load delta.

### Driving load: the loaded server

`npm run dev:server` boots an EMPTY room (no bots). Use the loaded-room harness
(already on main — reused unchanged) which pre-creates ONE labelled `game` room
with bots via the standard matchmaker; the client's netcode is **unchanged** and
its plain `joinOrCreate("game")` lands in it, rendering `botCount + 1` entities.

```bash
cd net/server
BOT_COUNT=24 SEED=12345 TICK=20 SCENARIO=n2-stress-ramp PORT=2567 \
  npm run dev:server:loaded
```

### Measurement mechanism

Three honest options:

**(a) Automated real-GPU runner (preferred, #191).** Run
`ENGINE=babylon node net/tools/realGpuRender.mjs` from the repo root **on a real
machine, keeping the launched Chrome window foreground**. It spawns the loaded
server (reusing the exact `?probe=1...` join-key query the server prints), builds +
`vite preview`s this client, launches a **headed Chrome** (real GPU, SwiftShader NOT
forced), verifies `UNMASKED_RENDERER_WEBGL` is non-SwiftShader, harvests
`window.__clientRenderSamples` over CDP into `web-babylon-client-render.realgpu.jsonl`
+ a `.meta.json` (GPU evidence), and kills every spawned process. It **aborts** if
the live renderer is software. Attended run (vsync, foreground rAF, thermal
cooldown). Full procedure + knobs: `net/tools/README.md`.

**(a2) Fully manual, real-GPU.** Start the loaded server, then `npm run dev`, open
the printed dev URL **with the probe query** in a real browser. The page exposes
`window.__clientRenderSamples` and `window.__downloadClientRenderJsonl()` (and
`console.log`s each line as `[client-render] {…}`). This uses your real GPU, so
fps/frame-time are representative.

**(b) Playwright smoke (auto, software-WebGL).** `smoke/renderProbe.smoke.mjs`
loads the built client headless against the loaded server, harvests
`window.__clientRenderSamples`, and writes the sidecar. **Caveat:** headless
Chromium renders WebGL via SwiftShader (software), so the absolute numbers are NOT
a real-GPU result — the pipeline and sample SHAPE are faithful, the magnitudes are
not. Playwright is intentionally **not** a dependency (keeps `npm install && npm
run build && npm test` browser-free); install it once to run the smoke. The
output-path env var is **`RENDER_OUT`** (distinct from the server's `OUT`, which
carries `MetricsSample` lines — never reuse `OUT` for the client sidecar). The
default `PROBE_QUERY` already includes `warmupMs`/`windowDurationMs`/`maxWindows`
matching the committed sample, so a bare-default run reproduces the artifact.

```bash
cd net/server      && BOT_COUNT=24 SEED=12345 TICK=20 PORT=2567 npm run dev:server:loaded   # terminal 1
cd net/web-babylon && npm run build && npx vite preview --port 4173                          # terminal 2
cd net/web-babylon && npm i -D playwright   # one-off; NOT a package.json dep
PREVIEW_URL=http://localhost:4173 \
  RENDER_OUT=../measurements/n2/web-babylon-client-render.jsonl \
  npm run smoke:render
```

A sample headless-smoke run is committed at
`net/measurements/n2/web-babylon-client-render.jsonl` (labelled software-WebGL in
that dir's README — replace with a real-GPU manual run for honest magnitudes).

## Scope (Won't Do here)

- No client-side prediction / reconciliation (N1 is low-twitch by design).
- No protocol fork — consumes `net/protocol` DTOs as-is; no babylon-specific
  server or room (piggybacks the shared "game" room).
- No Havok / physics — an N1 networking client renders authoritative poses; it
  does not simulate.
- Browser render verification is a manual / Playwright smoke (connect → self
  visible); the netcode logic is covered by the server's tests + the pure
  interpolation/input tests here.
