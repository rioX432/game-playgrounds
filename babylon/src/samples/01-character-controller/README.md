# 01 — Third-Person Character Controller

## What it demonstrates

A kinematic (non-physics) third-person controller built from scratch: a capsule
mesh parented to a yaw pivot, manual gravity/jump integration, pointer-lock mouse
look, and a Babylon `FollowCamera` that trails the player.

## Controls

| Input | Action |
|-------|--------|
| `W` / `A` / `S` / `D` | Move (relative to look heading) |
| Mouse (after click) | Look / turn (pointer-locked) |
| `Space` | Jump |
| Click canvas | Engage pointer lock |
| `Esc` | Release pointer lock |

## Feel & difficulty notes

- **Feel**: Snappy and arcade-y. `GRAVITY = -22` and `JUMP_SPEED = 9` give a
  short, punchy hop. Movement is instant (no acceleration ramp), which feels
  responsive but a little "on rails" — add easing if you want weight.
- **Difficulty**: Low. No physics engine involved; the hardest part is getting
  the yaw → world-space movement rotation correct.
- The `FollowCamera` smoothing (`cameraAcceleration = 0.08`) lags slightly behind
  fast turns, which reads as natural for third-person but can feel sluggish if you
  crank movement speed.

## Babylon-specific gotchas

- `FollowCamera` needs a `lockedTarget` (the player mesh) and does **not** require
  `attachControl`; it positions itself automatically each frame.
- Pointer lock is browser-gated: `canvas.requestPointerLock()` must be called from
  a user gesture (we use the canvas `click`). Read `e.movementX` only while
  `document.pointerLockElement === canvas`.
- Parenting the capsule to a `TransformNode` keeps yaw rotation and translation
  separate from the mesh's own transform, which avoids gimbal surprises.
- Ground collision here is a simple `y <= 0` clamp — there is no real collider.
