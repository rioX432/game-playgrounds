# 04 — First-Person Controller

## What it demonstrates
A minimal first-person (FPS-style) controller built from scratch (no physics
engine). Unlike the third-person sample 01 — which orbits a follow camera
behind a visible capsule — here **the camera *is* the player**: there is no
avatar mesh. Mouse look (yaw + pitch) drives the camera orientation directly via
a `YXZ` Euler (the canonical FPS order: yaw about world Y, then pitch about local
X, no roll). WASD moves on the horizontal plane relative to yaw only — looking up
or down never lifts or sinks the walk. Gravity integration + Space jump with
ground snapping match sample 01.

It reuses all three shared foundations:
- **Input** (`src/engine/input.ts`, `InputController`): keyboard state +
  pointer-lock yaw/pitch with a wider pitch clamp (near ±90°) so you can look
  almost straight up/down.
- **HUD** (`src/engine/hud.ts`, `Hud`): controls overlay (bottom-left) + FPS
  counter (top-right). `hud.frame(now)` advances the FPS readout each tick.
- **Scene primitives** (`src/engine/scene.ts`): `createLightPreset`,
  `createGround`, `createBoxGrid` — each a `PrimitiveSet` disposed on cleanup.

## Controls
- **Click canvas** — engage pointer lock.
- **Mouse** — look (yaw + pitch, clamped just shy of vertical).
- **W / A / S / D** — move relative to where you're facing (horizontal only).
- **Space** — jump (only when grounded).
- **Esc** — release pointer lock.

## Feel & difficulty notes
- First-person look feels markedly more *immediate* than the third-person follow
  camera: there's no orbital lag, the view turns 1:1 with the mouse. That makes
  it feel responsive but also unforgiving — there is no smoothing, so on a
  high-polling mouse the view can micro-jitter.
- Movement is velocity-free (instant start/stop), so it feels snappy/arcade-y
  rather than weighty. No acceleration, no friction, no air-control difference —
  air and ground movement are identical, which feels floaty mid-jump.
- Horizontal-only movement basis (pitch ignored for WASD) is the correct FPS
  convention; looking at the floor and pressing W still walks forward at full
  speed, not into the ground.
- Jump is edge-triggered (`consumeJustPressed("Space")`), so holding Space does
  not auto-bounce on landing — one tap per hop. Jump arc is ~0.8s. No coyote
  time / jump buffering (intentionally minimal).
- **Where it feels bad:**
  - No collision against the boxes — you walk straight through them. Combined
    with the lack of head-bob and footstep cues, there's little sense of
    physicality; depth comes only from parallax of the grid.
  - The pitch clamp is set just shy of ±90°; pushing the mouse hard up/down hits
    a hard stop with no easing, which feels abrupt.
  - No FOV / no run toggle / no crouch — eye height is fixed, so the world feels
    a touch tall and static.
  - Same as sample 01: alt-tab mid-strafe clears held keys (correct — no stuck
    keys), but you must re-press WASD on return.
- Difficulty: **low**. Pure kinematics, no collision solver.

## Three.js-specific gotchas
- **Camera orientation order matters.** Setting yaw and pitch as a `YXZ` Euler
  and assigning via `camera.quaternion.setFromEuler(...)` is what keeps the
  horizon level (no roll). Using the default `XYZ` order, or `camera.rotation.x/y`
  set independently, introduces roll as you turn. `three/examples`'
  `PointerLockControls` uses exactly this `YXZ` trick internally; here it's wired
  by hand to stay dependency-free.
- **Pitch must be clamped short of ±π/2.** At exactly straight up/down the YXZ
  basis degenerates (gimbal lock) and the view can snap; clamping to
  `±(π/2 − 0.01)` avoids it. The shared `InputController` does the clamping.
- `e.movementX/Y` are only non-zero while pointer lock is active; the shared
  input module guards every mouse-move on `isPointerLocked`.
- The engine runs the render loop; the sample runs its **own**
  `requestAnimationFrame` for state updates and cancels it in dispose. Forgetting
  to cancel leaks a loop per sample switch.
- GPU resource leaks: removing meshes from a scene does NOT free their
  geometry/material. The shared `PrimitiveSet`s track and dispose everything they
  create; this sample creates no meshes of its own (the camera needs none), so
  cleanup is just cancel-rAF + `input.dispose()` + `hud.dispose()` + disposing
  the three primitive sets.
