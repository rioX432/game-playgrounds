# 13 — Stress / Load Harness (Babylon.js + Havok)

## What it demonstrates

The cross-engine **performance probe** (sibling of the `three/` and `bevy/`
harnesses): spawn batches of dynamic boxes onto a floor and watch the per-frame
cost climb as the body count rises. A live readout shows
`bodies: N | ms/frame: X (~FPS)`. Havok auto-steps and auto-syncs each
`PhysicsAggregate`'s mesh, so there is no manual stepping or body→mesh copy here.

## Controls

| Input | Action |
|-------|--------|
| `Space` | Add 100 dynamic boxes (up to a 2000 cap) |
| `R` | Clear all boxes |
| Left-drag / wheel | Orbit / zoom the camera |

## Feel & difficulty notes

- **The point is the ramp.** Tap `Space` and the `ms/frame` number climbs as the
  Havok solver + draw calls add up; where it crosses ~16.7 ms (60 FPS) on your
  machine is the honest headroom.
- **Honest caveat — numbers are NOT in COMPARISON.md.** Matched ms/frame across
  Three / Babylon / Bevy must be captured by *running* each build; asserting
  numbers without measuring would be dishonest. This harness produces the
  measurement; recording it is a follow-up.
- Boxes are clones of one hidden template (shared geometry + material) — not thin
  instances, so at high counts draw cost shows alongside physics.

## Babylon-specific gotchas

- Havok WASM loads on demand via `getHavokPlugin()`; physics is enabled per scene
  with `scene.enablePhysics(gravity, plugin)`, guarded by a `disposed` flag.
- Each body is a `PhysicsAggregate(mesh, BOX, { mass: 1 }, scene)`; Havok writes
  the body pose back to the mesh automatically every frame.
- Clearing disposes BOTH the aggregate and the mesh (the aggregate owns the body
  + shape; disposing only the mesh would leak the body).
