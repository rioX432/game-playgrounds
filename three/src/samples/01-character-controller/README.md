# 01 — Character Controller

## What it demonstrates
A minimal third-person capsule controller built from scratch (no physics
engine): WASD planar movement relative to camera yaw, pointer-lock mouse look,
gravity integration, jump with ground snapping, and a spherical follow camera.

It is also the first consumer of the **shared input module**
(`src/engine/input.ts`, `InputController`): keyboard state polling
(`isDown` / `consumeJustPressed`) plus pointer-lock-based yaw/pitch. All input
listeners live inside the controller and are removed on `input.dispose()`, so
the sample's own cleanup is just "cancel the RAF, dispose the input".

## Controls
- **Click canvas** — engage pointer lock.
- **Mouse** — look (yaw + clamped pitch).
- **W / A / S / D** — move relative to facing.
- **Space** — jump (only when grounded).

## Feel & difficulty notes
- Movement is velocity-free on the horizontal plane (instant start/stop) which
  feels snappy but arcade-y; add acceleration for weightier feel.
- Jump arc is tuned via `JUMP_VELOCITY` / `GRAVITY`; current values give a
  ~0.8s hop. Coyote time and jump buffering are NOT implemented (intentionally
  minimal).
- Jump is now **edge-triggered** via `consumeJustPressed("Space")` instead of
  the old "Space held + grounded" check. A tap feels identical, but holding
  Space no longer auto-bounces the instant you touch the ground — slightly less
  twitchy, more deliberate.
- The follow camera has no collision — it can clip through boxes.
- **Where it feels bad:** mouse-look has no smoothing, so on a high-DPI / high-
  polling mouse the camera can feel jittery, and there is zero look
  acceleration or deadzone — fast flicks over-rotate. The shared module reports
  raw accumulated yaw/pitch by design; smoothing is left to the sample and is
  not done here. Also, if you alt-tab mid-strafe the module's `blur` handler
  clears held keys (correct, no stuck keys) but you must re-press WASD on
  return — there is no "remember held keys".
- Difficulty: **low**. Pure kinematics, no collision solver.

## Three.js-specific gotchas
- `PointerLockControls` exists in `three/examples`, but here lock is wired
  manually inside `InputController` to keep things dependency-free and expose
  the raw API (`element.requestPointerLock()` + `document.pointerLockElement`).
- `e.movementX/Y` are only non-zero while pointer lock is active; the shared
  module guards every mouse-move on `isPointerLocked`.
- The engine runs the render loop; the sample runs its own `requestAnimationFrame`
  for state updates and cancels it in the dispose fn. Forgetting to cancel leaks
  a loop per sample switch.
- Listener leaks: this sample used to register 4 listeners inline. They now live
  in `InputController`; the single `input.dispose()` removes them all — the
  pattern future input-driven samples should reuse.
