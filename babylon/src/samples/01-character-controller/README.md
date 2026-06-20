# 01 — Third-Person Character Controller

## What it demonstrates

A kinematic (non-physics) third-person controller built from scratch: a capsule
mesh parented to a yaw pivot, manual gravity/jump integration, pointer-lock mouse
look, and a Babylon `FollowCamera` that trails the player.

Input is **not** wired inline here — it goes through the shared `engine/input`
module (`createInput(scene, canvas)`), which exposes keyboard key-state polling
(`isKeyDown`) plus accumulated pointer-lock look deltas (`consumeLookX/Y`). This
sample is the reference consumer of that module.

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
- **Where it feels bad**: look is consume-on-frame, so a frame hitch (or a tab
  that just regained focus) can dump one large `movementX` burst into yaw and
  snap the heading. There is no smoothing/clamp on the look delta — fine at
  steady framerate, jarring on a stutter.

## Babylon-specific gotchas

- **Shared input via scene observables.** `engine/input` uses
  `scene.onKeyboardObservable` / `scene.onPointerObservable`, which are owned by
  the scene and torn down by `scene.dispose()`. The gallery disposes the whole
  scene on every switch, so this is leak-safe by construction; the module's
  `dispose()` still removes its observers + the one `document`
  `pointerlockchange` listener and exits pointer lock if it owns it.
- **Pointer lock from a gesture.** Lock is engaged from a `POINTERDOWN` (a user
  gesture, as browsers require) via `engine.enterPointerlock()`, not a raw
  `canvas.requestPointerLock()`. Look deltas are read only while
  `document.pointerLockElement === canvas`.
- `FollowCamera` needs a `lockedTarget` (the player mesh) and does **not** require
  `attachControl`; it positions itself automatically each frame. We avoid mixing
  camera `attachControl` with manual pointer-lock look — the input module owns
  the whole look model.
- Parenting the capsule to a `TransformNode` keeps yaw rotation and translation
  separate from the mesh's own transform, which avoids gimbal surprises.
- Ground collision here is a simple `y <= 0` clamp — there is no real collider.
