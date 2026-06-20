# 02 — Physics Grab & Throw (Havok)

## What it demonstrates

A real rigid-body world driven by Babylon's Havok physics v2 plugin: a static
floor, several dynamic boxes, and a raycast-based grab/hold/throw interaction. The
held body is sprung toward a point in front of the camera each frame, then thrown
with an impulse on release. This is the "REPO / Gang Beasts"-style toy mechanic.

## Controls

| Input | Action |
|-------|--------|
| Left-drag | Orbit camera |
| Mouse wheel | Zoom |
| Pointer down (on a box) | Grab the nearest dynamic box |
| Pointer up | Throw the held box along the camera forward |

## Feel & difficulty notes

- **Feel**: Floaty-grabby. The hold spring (`SPRING = 60`, velocity-set each frame)
  makes bodies snap to the hold point with slight overshoot. Heavier damping reads
  as "magnetic"; lighter reads as "rubber band". `THROW_IMPULSE = 18` lobs a 1 kg
  box a satisfying distance.
- **Difficulty**: Medium. The physics interaction itself is easy; the friction is
  all in the Havok WASM bootstrap (see gotchas).
- Setting linear velocity directly (rather than applying a spring force) is cheap
  and stable, but ignores mass — fine for a uniform-mass playground.

## Babylon-specific gotchas

- **Havok WASM init**: `HavokPhysics()` (from `@babylonjs/havok`) is async and
  fetches a `.wasm` binary. Vite must **not** pre-bundle it — see
  `vite.config.ts` `optimizeDeps.exclude`. We load the plugin once via
  `src/engine/havok.ts` and reuse it across scenes; only
  `scene.enablePhysics(gravity, plugin)` is per-scene.
- Because init is async, the sample may be torn down before Havok finishes. We
  guard every post-load action with a `disposed` flag.
- Use `PhysicsAggregate` (v2 API) — it bundles body + shape. `mass: 0` makes a
  static collider (the floor).
- `scene.createPickingRay(...)` + `scene.pickWithRay(ray, predicate)` filters the
  raycast to only the dynamic boxes; otherwise the floor would be grabbed.
- Import side-effect modules (`@babylonjs/core/Physics/physicsEngineComponent`,
  `.../Culling/ray`) so the tree-shaken core wires up physics + raycasting.
