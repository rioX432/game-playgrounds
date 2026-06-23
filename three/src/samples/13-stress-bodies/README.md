# 13 — Stress / Load Harness (Three.js + Rapier)

## What it demonstrates

The cross-engine **performance probe**. Spawn batches of dynamic boxes onto a
floor and watch the per-frame cost climb as the body count rises. The same
harness exists in `babylon/` and `bevy/` so the three engines can be compared
under matched load. A live readout shows `bodies: N | ms/frame: X (~FPS)`.

This is the sample COMPARISON.md §5 calls out as the most valuable missing
piece — it turns "performance is fine, probably" into something you can measure.

## Controls

| Input | Action |
|-------|--------|
| `Space` | Add 100 dynamic boxes (up to a 2000 cap) |
| `R` | Clear all boxes |

## Feel & difficulty notes

- **The point is the ramp, not a single frame.** Tap `Space` repeatedly and the
  `ms/frame` number climbs as Rapier's solver and the draw calls add up. Where it
  crosses ~16.7 ms (60 FPS) on your machine is the honest headroom for these
  light scenes.
- **Honest caveat — numbers are NOT in COMPARISON.md.** Capturing matched
  ms/frame across Three / Babylon / Bevy (same body count, same machine) must be
  done by *running* each build; asserting numbers without measuring would be
  dishonest. This harness produces the measurement; recording it is a follow-up.
- **Rendering is not instanced.** Boxes share one geometry + material but are
  individual meshes, so at high counts draw cost (not just physics) shows.
  Instanced rendering is the obvious next step to isolate physics cost.

## Three.js gotchas

- Rapier's `-compat` build is async WASM (`RAPIER.init()`); the world is built
  only after it resolves, guarded by a `disposed` flag against unmount-during-await.
- `world.free()` on dispose frees the WASM world; meshes/geometry/material are
  disposed explicitly (Three never auto-frees GPU resources).
- Each body's pose is copied from `rb.translation()` / `rb.rotation()` to its mesh
  every frame (manual sync — Three has no physics writeback).
