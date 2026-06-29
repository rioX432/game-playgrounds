# 14 — Navmesh Pathfinding (A→B + dynamic re-path)

## What it demonstrates

NPC pathfinding on a **Recast/Detour navmesh** (the Ch4 "raw / direct library"
integration — we own WASM init, navmesh generation and queries ourselves; see
`src/ai/navmesh/`). An agent walks an A→B route around a central pillar; partway
through, a **dynamic obstacle drops onto its corridor**. The navmesh **re-bakes**
with the new blocker and the agent **re-paths from its current position**,
routing around *both* obstacles to the goal. Then the run loops.

The pathfinding logic is a **pure, render-independent core**
(`pathfind.ts` → `PathfindScenario`): it builds the navmesh, queries paths, and
performs the dynamic re-bake without touching three.js. The Sample's `mount(ctx)`
only *visualizes* it (navmesh overlay + path line + capsule agent + obstacle
boxes). The same core is asserted headlessly in `pathfind.test.ts`.

## Controls

- **Space** — drop the dynamic obstacle now (otherwise it auto-drops ~2.2 s in).
- **R** — reset the run immediately.
- The agent auto-re-routes the instant the navmesh re-bakes; the run loops on
  arrival.

## Feel & difficulty notes

- **The re-path reads instantly and feels "smart".** Because the agent re-queries
  from its *live* position (snapped onto the mesh) rather than from the start, the
  turn happens right where it stands — it looks like the NPC noticed the wall and
  reconsidered, not like a script restart.
- **The seam is the re-bake, not the query.** A solo-navmesh rebuild is a
  full re-rasterize of the merged scene; on this ~20 m primitive course it is a
  sub-millisecond, single-frame hitch (no visible stall), but it is a *rebuild*,
  not an incremental obstacle carve. Detour *does* ship tile/`TileCache` obstacle
  primitives for true incremental updates — deliberately unused here to keep the
  core symmetric with Bevy's stack (a finding for the chapter writeup, per the
  foundation README's "crowd / dynamic" notes).
- **Movement is intentionally minimal.** The agent follows the path polyline at a
  constant speed with corner-snapping — *not* steering. Seek/arrive/avoid and FSM
  decision-making are out of scope here (samples 15 `steering` / 16 `guard-ai`);
  this sample is purely "can it find and re-find a route".

## Determinism finding (foundation risk, resolved)

The navmesh foundation flagged **dynamic-obstacle re-bake determinism** as an
untested risk. Measured here: in the headless (`node`) vitest environment the
re-bake is **deterministic** — independent fresh re-bakes of the same scene
produce an identical path corner count run-to-run. Per the Ch4 design (§3.1), the
test still asserts only **robust** properties (goal reached within a threshold;
no path corner intrudes either obstacle footprint, inset by the agent radius;
≥ 3 corners = a real detour) rather than an exact point sequence, which would
drift with WASM init / Recast parameters / float rounding. A `Set`-of-counts
check additionally surfaces any future run-to-run drift.

## Three.js gotchas

- **The active navmesh changes identity on re-bake**, so the `NavMeshHelper`
  overlay must be **rebuilt** (dispose + recreate via `createNavmeshDebug`) after
  `dropObstacle()` — otherwise the overlay would still show the un-carved mesh.
  The yellow path line, by contrast, is one reused dynamic buffer (`setPath`).
- **`Navmesh.destroy()` has no double-free guard** (it frees WASM memory). The
  Sample frees the old navmesh inside `dropObstacle()`/`reset()` and the last one
  on dispose; the headless test nulls its handle after `destroy()` so `afterEach`
  never double-frees.
- **`mount()` is synchronous but WASM init is async.** Init is kicked off inside
  `mount` and wired up in `.then()` behind a `disposed` guard, so switching away
  before the navmesh loads leaks nothing.
- **A solid ground slab, not a flat quad**, is what makes the navmesh non-empty
  (baked into the foundation's `boxTriMesh`); the visible ground plane sits a hair
  below `y = 0` so it never z-fights the translucent navmesh overlay.
