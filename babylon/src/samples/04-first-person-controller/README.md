# 04 — First-Person Controller

## What it demonstrates
A minimal first-person (FPS-style) controller with no physics engine. Unlike the
third-person sample 01 — a follow camera orbiting a visible capsule — here **the
camera *is* the player**: there is no avatar mesh, just an eye positioned at
standing height. Mouse look drives the camera's yaw + pitch directly; WASD moves
on the XZ plane relative to yaw only (looking up or down never lifts or sinks the
walk — the classic FPS convention). Gravity integration + Space jump with a
ground clamp at eye height mirror sample 01 and the Three.js sample 04.

It reuses all three shared foundations:
- **Input** (`src/engine/input.ts`, `createInput`): keyboard state + pointer-lock
  look deltas. We apply our own sensitivity scaling and pitch clamp.
- **HUD** (`src/engine/hud.ts`, `createHud`): controls overlay (bottom-left) +
  FPS counter (top-right).
- **Scene primitives** (`src/engine/scene.ts`): `createLightPreset`,
  `createGround`, `createBoxGrid` — visible reference props to gauge motion
  against. These are scene-owned and freed by `scene.dispose()` on switch.

The camera is a `UniversalCamera` used purely as a transform: we set its
`position` and `rotation` every frame and **never call `attachControl`**, so
Babylon's built-in camera input never fights our manual pointer-lock look.

## Controls
| Input | Action |
|---|---|
| Click canvas | Engage pointer lock |
| Mouse | Look (yaw + pitch, clamped just shy of vertical) |
| W / A / S / D | Move relative to where you're facing (horizontal only) |
| Space | Jump (only when grounded) |
| Esc | Release pointer lock |

## Feel & difficulty notes
- First-person look feels markedly more *immediate* than sample 01's follow
  camera: no orbital lag, the view turns 1:1 with the mouse. Responsive, but also
  unforgiving — there is no smoothing, so on a high-polling mouse the view can
  micro-jitter.
- Movement is velocity-free (instant start/stop): snappy/arcade-y rather than
  weighty. No acceleration, no friction, and air movement is identical to ground
  movement, which feels floaty mid-jump.
- Diagonal input is normalized, so W+D is not faster than W alone.
- Jump is edge-triggered (held Space does not auto-bounce on landing — one tap
  per hop). Jump arc is ~0.8 s. No coyote time / jump buffering (intentionally
  minimal).
- `LOOK_SENSITIVITY = 0.0025` rad/px is the constant that most shapes the feel;
  lower it for a heavier turn, raise it for twitch aiming.
- **Where it feels bad:**
  - No collision against the boxes — you walk straight through them. With no
    head-bob or footstep cues, there is little sense of physicality; depth comes
    only from the parallax of the grid.
  - The pitch clamp is a hard stop just shy of ±90° with no easing, which feels
    abrupt when you push the mouse hard up or down.
  - No FOV change / run toggle / crouch — eye height is fixed, so the world feels
    a touch tall and static.
  - Alt-tab mid-strafe: the shared input drops held keys on pointer-lock loss
    (correct — no stuck keys), but you must re-press WASD on return.
- Difficulty: **low**. Pure kinematics, no collision solver, no physics plugin.

## Babylon-specific gotchas
- **Don't `attachControl` and also drive look manually.** A `UniversalCamera`
  ships with its own keyboard/mouse input managers; calling `attachControl` plus
  feeding it our pointer-lock deltas means two input models fight over the camera
  (CLAUDE.md → Think Twice). Here we never attach control and set
  `camera.rotation`/`camera.position` ourselves.
- **`UniversalCamera.rotation` is `(x = pitch, y = yaw, z = roll)`** in Euler.
  At `(0, 0, 0)` it looks down **+Z** (opposite to Three.js, whose camera looks
  down −Z). The movement basis is derived from this: at yaw `θ` the camera looks
  along `(sin θ, *, cos θ)` on XZ, so forward = `(sin θ, cos θ)` and right =
  `(cos θ, −sin θ)`. Start yaw is `π` to face the grid at the origin.
- **The scene needs an active camera.** The shared render loop calls
  `scene.render()`, which throws without `scene.activeCamera`. We set it
  explicitly; we do not rely on the auto-assignment that only the first created
  camera gets.
- **Pitch must be clamped short of ±π/2.** At exactly vertical the view can snap;
  clamping to `±(π/2 − 0.01)` avoids it. We clamp our own pitch accumulator.
- **Pointer-lock deltas are only non-zero while locked.** The shared input module
  guards every mouse-move on `document.pointerLockElement === canvas` and zeroes
  the accumulated deltas when the lock is lost, so look never jumps on re-entry.
- **Side-effect imports.** The scene primitives module already pulls in the
  ground/box builders; importing `UniversalCamera` from its deep path registers
  the camera class. No extra builder side-effect imports are needed here because
  this sample creates no meshes of its own.
