# 01 — Character Controller

## What it demonstrates
A minimal third-person capsule controller built from scratch (no physics
engine): WASD planar movement relative to camera yaw, pointer-lock mouse look,
gravity integration, jump with ground snapping, and a spherical follow camera.

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
- The follow camera has no collision — it can clip through boxes.
- Difficulty: **low**. Pure kinematics, no collision solver.

## Three.js-specific gotchas
- `PointerLockControls` exists in `three/examples`, but here lock is wired
  manually to keep the sample dependency-free and show the raw API
  (`canvas.requestPointerLock()` + `document.pointerLockElement`).
- `e.movementX/Y` are only non-zero while pointer lock is active; always guard.
- The engine runs the render loop; the sample runs its own `requestAnimationFrame`
  for state updates and cancels it in the dispose fn. Forgetting to cancel leaks
  a loop per sample switch.
