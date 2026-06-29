# 14 — Navmesh Pathfind + Dynamic Re-path

A* over a Recast/Detour navmesh, reached through Babylon's engine-integrated
`RecastJSPlugin`. An agent walks from A (green) to B (red) on the computed corridor
path; partway across, a wall drops onto the route, the navmesh is rebuilt with the
obstacle, and the path is recomputed from the agent's current position so it visibly
detours through the one remaining gap. The whole thing loops.

This is sample 14 of Chapter 4 (NPC/AI). It builds on the Ch4 foundation in
`src/ai/` (navmesh generation + query + debug overlay) — see `src/ai/README.md`.

## What it demonstrates

- **Engine-integrated navmesh** — `RecastJSPlugin.createNavMesh` / `computePath` /
  `createDebugNavMesh`, the "wrapped" side of the Ch4 control experiment (Three calls
  recast-navigation-js raw; Babylon reaches the *same* Recast/Detour core through the
  engine). The reusable wrapper lives in `src/ai/navmesh.ts`.
- **Dynamic re-path** — modeled by **rebuilding the navmesh with the blocker added**
  (not a tile-cache obstacle mutation), then re-querying from the agent's live
  position. This is the most deterministic, headless-testable way to do it.
- **Pure-core / visualization split** — all path logic (scenario geometry + a minimal
  follow stepper) sits in `pathfind.ts`, render-independent and proven under
  `NullEngine` in `pathfind.test.ts`. This `index.ts` is only meshes, camera, the
  navmesh overlay, and the per-frame follow tick.

## Controls

- **Drag** — orbit the camera. That's it; the demo drives itself and loops.

## Feel & difficulty notes

- The detour reads clearly *because* the obstacle drops while the agent is still on
  the open straight line — you see the path snap from a straight shot to a curve
  through the gap. Dropping it too late (agent already at the wall) would look like a
  teleport, not a re-path.
- Re-pathing by full navmesh rebuild is **visually instant** at this scale (one wall,
  a 20×20 ground) — there is no hitch. At real scale you would scope the rebuild to
  affected tiles (Recast tile-cache) instead; that is out of scope here.
- The agent uses the **minimum** steering to follow the corridor (move toward the next
  waypoint, snap within a small radius). Proper seek/arrive/avoid steering is sample
  15; FSM decision-making is sample 16 (`guard-ai`).
- The corridor is Detour's straight string-pulled path, so turns are hard corners, not
  smoothed arcs. V1 `computePathSmooth` is deliberately avoided — on this scene it
  returns a degenerate path (see the foundation gotchas).

## Babylon-specific gotchas

- **`walkable*` params are voxels, not world units.** `DEFAULT_NAV_PARAMS` uses
  `walkableRadius: 4` voxels (≈0.8 world units at `cs = 0.2`) so paths keep clear of
  blocker footprints. A value of `1` erodes only 0.2 units and the path hugs walls.
- **Wall-with-a-gap, not a free-standing box.** The dynamic wall reaches the −Z edge
  and stops short of the +Z edge, leaving exactly one gap. A box the path could pass on
  either side gets a corner clipped between two waypoints by the straight string-pull;
  a wall that touches an edge forces the detour through one opening, so segments never
  cross the footprint. The headless test asserts this non-intrusion.
- **Rebuild dispose order.** A re-path disposes the old debug overlay mesh **and** the
  old `RecastJSPlugin` (native Recast memory) before creating the new one. Leaking the
  plugin across rebuilds would leak WASM heap.
- **Async WASM vs. scene switch.** `loadRecast()` resolves a frame or more later; the
  mount guards with a `disposed` flag so a fast sample switch doesn't build meshes into
  a torn-down scene.

## Headless proof (`pathfind.test.ts`)

Robust properties only — never an exact point-sequence (navmesh output drifts with
WASM init / Recast params / float order; the Ch4 design forbids point-equality asserts).
Every check guards against a vacuous empty-path pass:

1. **Base path reaches the goal** on open ground.
2. **Dynamic obstacle forces a re-path** that (a) still reaches the goal, (b) never
   intrudes the wall AABB — checked at every waypoint *and* by dense segment sampling —
   and (c) is materially longer than the open path (a real detour happened).
3. **Re-path is deterministic** — two independent rebuilds of the obstacle navmesh
   produce identical paths.
4. **The follow stepper converges** — an agent integrating the follow logic over the
   re-path ends within the goal threshold.

## Finding: crowd unused

Babylon ships `RecastJSPlugin.createCrowd` + dynamic `addBoxObstacle` /
`addCylinderObstacle` (tile-cache) — an engine convenience the raw-library Three side
must hand-roll. Per the Ch4 design, steering is hand-rolled across all three engines to
keep the comparison axis uncrossed, so crowd is **recorded, not used** here.
