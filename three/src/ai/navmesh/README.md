# Navmesh foundation (Ch4 — NPC/AI, Three.js)

The **"raw / direct library" navmesh stack** for the Ch4 NPC/AI chapter. Three's
role in this chapter is to integrate the pathfinding library _directly_
(generate, query, visualize ourselves) — in contrast to Babylon's engine-wrapped
plugin and Bevy's ECS-native crates. This module is the foundation the later
`navmesh-pathfind` and `guard-ai` samples build on; it ships no gallery sample
of its own.

Stack: [`recast-navigation`](https://github.com/isaac-mason/recast-navigation-js)
v0.43.1 (Detour) + `@recast-navigation/three` v0.43.1 (debug overlay only).

## Architecture: a pure, render-independent core

Mirrors the `measure/probe` idiom — the logic is a pure module, testable with no
GPU and no window; the Three.js visualization is isolated.

| File | three.js? | Role |
|------|-----------|------|
| `geometry.ts` | no | `TriMesh`/`Vec3`/`AabbXZ` DTOs, box builder, mesh merge, XZ-AABB tests |
| `navmesh.ts` | no | WASM `initNavmesh()`, `generateNavmesh()`, `Navmesh` (query wrapper), path-assert helpers |
| `scene.ts` | no | `buildObstacleCourse()` — the deterministic ground+obstacle scene |
| `index.ts` | no | barrel for the pure core |
| `debugView.ts` | **yes** | `createNavmeshDebug(scene, navmesh)` — translucent navmesh + path line; called inside a Sample's `mount(ctx)` |

`debugView.ts` is intentionally **not** re-exported from `index.ts`, so the core
barrel stays three-free and headless-importable.

## Headless proof (`navmesh.test.ts`)

Runs in the `node` vitest environment. It establishes WASM init and asserts only
**robust** properties of a seed-free deterministic scene — never an exact path
point sequence (that drifts with WASM init / Recast params / float rounding):

1. **WASM init** resolves and is idempotent.
2. A solo navmesh **builds** from primitive geometry.
3. An A→B query **reaches the goal** (final XZ distance < 0.5 m).
4. The path **does not intrude** the blocked obstacle footprint (inset by the
   agent radius so a legitimate wall-hug is not flagged).
5. Start→goal also **detours** (≥ 3 corners): the straight line crosses the
   obstacle, so a 2-point line would be a false pass.
6. Generation **fails gracefully** (returns `{ success: false }`, no throw) on
   degenerate input.

## Decisions & gotchas

- **WASM init in node works out of the box.** `await init()` loads the embedded
  Emscripten module under vitest's `node` environment — no config change, no
  custom test environment. `initNavmesh()` caches the promise (process-wide
  singleton) and clears it on failure so a retry is possible.
- **A solid slab is required — a single flat quad fails.** A degenerate flat
  quad (`y` constant) rasterizes to a zero-height heightfield and yields **0
  polygons** (`generateSoloNavMesh` then reports "Failed to create Detour
  navmesh data"). The ground is therefore a thin **box** with a real top face.
  This is the single biggest foundation foot-gun and is baked into `boxTriMesh`.
- **Voxel vs. world units.** `cs`/`ch` are world units; `walkableRadius/Height/
  Climb` are **voxels**. `NavmeshConfig` renames the voxel fields `*Vx` to make
  this explicit at every call site.
- **One navmesh per merged scene.** Recast builds from a single
  (positions, indices) pair, so `mergeTriMeshes` concatenates ground + obstacles
  (offsetting indices) before generation.

## Out of scope (finding notes for later)

- **Detour Crowd is deliberately unused.** Steering is hand-rolled in a later
  sample so the three engines stay on equal footing (Bevy has no Detour crowd);
  using `recast-navigation`'s `Crowd` here would confound the steering axis. Its
  availability ("the raw library _does_ ship a crowd") is the finding to record
  in the chapter writeup, not a thing to integrate now.
- **Steering / FSM** (samples `steering`, `guard-ai`) and **dynamic obstacle
  re-baking** are later issues that depend on this foundation.
