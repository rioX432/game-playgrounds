# 02 — Physics Grab & Throw

## What it demonstrates
A Rapier 3D physics world with dynamic boxes on a static floor. Raycasting from
the crosshair (screen center) selects the nearest body; while held it is driven
toward a point in front of the camera by setting its linear velocity; a second
click releases it with a forward impulse (throw).

## Controls
- **Click** (with crosshair over a box) — grab the nearest box.
- **Click** again — throw the held box along the view direction.

## Feel & difficulty notes
- Holding is implemented as a velocity spring (`HOLD_STIFFNESS`), not a fixed
  joint — it feels slightly rubbery, which reads as "telekinesis" rather than a
  rigid grab. Swap to a `RAPIER` joint for a stiffer hold.
- Throw strength is a single impulse (`THROW_IMPULSE`); there is no charge-up.
- Restitution is low (0.2) so boxes settle quickly; raise it for bouncier feel.
- Difficulty: **medium**. The mesh↔body sync and the async WASM init are the
  fiddly parts.

## Three.js-specific gotchas
- **Rapier `-compat` WASM init**: you MUST `await RAPIER.init()` before creating
  a `World`. The sample does this in `mount` and guards a `disposed` flag so an
  unmount during the await does not build a world into a dead scene.
- Rapier and Three.js have separate math types — sync each mesh from
  `rb.translation()` / `rb.rotation()` every frame; do not share Vector3.
- `raycaster.setFromCamera(new Vector2(0,0), camera)` casts through screen
  center (the crosshair), independent of the actual mouse position.
- Call `world.free()` on dispose to release WASM memory.
