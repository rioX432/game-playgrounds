# `src/ai` — NPC/AI core (Chapter 4 foundation)

Render-independent NPC/AI logic for the Babylon playground, kept separate from any
sample's `mount` so it is unit-testable under `NullEngine` with no DOM/GPU — the
same "pure core, visualization is a thin shell" split as `src/measure` (the render
probe). Later Ch4 samples (navmesh-pathfind, guard-ai) build their visualization on
top of this; this foundation issue ships only the navmesh core, a debug helper, and
the headless proof.

## Files

| File | Role |
|------|------|
| `recast.ts` | Loads + memoises the `recast-detour` Emscripten (WASM) module that Babylon's V1 nav plugin needs injected. |
| `navmesh.ts` | Pure core: numeric `NavSceneSpec` → `RecastJSPlugin` navmesh + `computePath`, normalised to a plain `Vec3` DTO. `buildHeadlessNav` is the self-contained NullEngine entry point. |
| `navmeshDebug.ts` | Minimal translucent navmesh overlay (`createDebugNavMesh` + material) for later samples. |
| `navmesh.test.ts` | NullEngine headless proof — robust properties only. |

## Version decision: **(a) Babylon 7 / V1 `RecastJSPlugin`** — chosen

The Ch4 design (§5.1) flagged a foundation decision between:

- **(a)** stay on the repo's `@babylonjs/core ^7.54` and use the V1 `RecastJSPlugin`, or
- **(b)** upgrade to Babylon 9.x and adopt the recast-navigation-js-based Nav Plugin V2
  (which would share the *exact* core with the Three side).

**We chose (a), validated by a working headless spike.** Rationale, with measured cost:

- **Upgrade cost of (b) is disproportionate for a foundation.** The repo is on
  `7.54.3`; the current major is **`9.14.0`** — (b) is a **two-major** engine bump
  underneath a **13-sample** gallery that leans on Havok Physics v2, spatial audio,
  ragdoll, and the inspector. The whole gallery must stay `npm run build`-green; a
  7→9 jump is exactly the broad-breakage risk the issue called out, and it is far
  outside a foundation's scope. (b) also does **not** reduce dependencies — it still
  pulls in a separate recast-navigation adapter on top of the engine bump.
- **(a) is minimal and provably green.** `RecastJSPlugin` already ships inside
  `@babylonjs/core 7.54`; the only new dependency is **`recast-detour` (1.6.4)** — the
  WASM module the plugin expects injected — whose sole dependency is `@types/emscripten`.
  Build, typecheck, lint, and the headless tests are all green with no change to any
  existing sample.
- **The control comparison still holds.** Ch4's Babylon↔Three axis is *integration
  height* ("engine-integrated wrapper" vs. "raw library"), not core identity. With (a),
  Babylon still reaches Recast/Detour through an engine-integrated API
  (`createNavMesh` / `computePath` / `createDebugNavMesh`), while Three calls
  recast-navigation-js directly. The one thing (a) gives up is *literally the same
  WASM core* on both sides — a nuance, documented as a caveat, not a blocker.

### Caveat / follow-up

- **V1 is deprecation-bound.** When the gallery eventually does its own Babylon major
  bump (a separate, gallery-wide decision — not an NPC/AI concern), migrate this core
  to Nav Plugin V2. The `Vec3`-DTO boundary and the `createNavMesh` / `buildHeadlessNav`
  seams are deliberately thin so that swap is localized to `recast.ts` + `navmesh.ts`.

## Headless proof — what is (and isn't) asserted

Navmesh generation is sensitive to WASM init, Recast parameters, and float order, so
`navmesh.test.ts` asserts **robust properties**, never an exact path point-sequence:

- **Goal reached** — the path's final point is within `REACH_THRESHOLD` of the goal.
- **No intrusion into the blocked AABB** — dense segment sampling finds no point of
  the path inside the wall footprint.
- **Detour happened** — the walled path is materially longer / has more waypoints than
  the open-ground path.
- **Determinism** — a repeated query on the same navmesh is identical.
- **Unreachable** — a goal off the navmesh yields an empty path.

### Measured gotchas (evidence from the spike)

- **`walkable*` parameters are in voxels, not world units.** With `cs = 0.2`,
  `walkableRadius: 1` erodes only 0.2 world units — too little to keep paths clear of
  blockers. `DEFAULT_NAV_PARAMS` uses `walkableRadius: 4` (≈0.8 world units), which
  makes dense segment sampling find **zero** intrusion into the wall AABB.
- **Use a wall-with-a-gap, not a single box, for non-intrusion.** Detour's straight
  `computePath` string-pulls and can clip an obstacle *corner* between two waypoints.
  A thin wall with a side gap forces the detour to thread the gap, so straight segments
  never cross the wall's footprint.
- **Avoid V1 `computePathSmooth` for this proof.** On this scene it returned a
  degenerate path (absurd total length, points inside the obstacle). The straight
  `computePath` is the reliable query; sample visualization should treat it likewise.

## Out of scope (this foundation)

- **Steering and FSM** — later samples (steering, guard-ai).
- **Crowd / agents** — finding note only: Babylon's `RecastJSPlugin.createCrowd` and
  dynamic `addCylinderObstacle` / `addBoxObstacle` exist and are an "engine-provided"
  convenience the raw-library Three side must hand-roll. Per the design, steering is
  hand-rolled across all three engines to keep the comparison axis uncrossed, so crowd
  is **recorded, not used**, here.
