# 11 — Top-Down Twin-Stick Movement

## What it demonstrates

The classic **twin-stick** decoupling: the player's **movement** direction and
its **facing/aim** direction are independent.

- **Movement** is driven by WASD on fixed **world axes** (W = up/-Z, S = down/+Z,
  A = -X, D = +X), normalized so diagonals aren't faster.
- **Facing** is driven by the **absolute mouse cursor**. Every frame the cursor's
  screen position is ray-cast against the ground plane (`THREE.Plane` at y = 0
  via `Raycaster.ray.intersectPlane`) to get a world-space aim point, and the
  player rig rotates its Y to face it.

Because they're separate inputs, you can strafe left while aiming right — hold
`D` and sweep the mouse the opposite way and the body slides one way while the
yellow nose tracks the cursor. A red ground reticle marks the aim point so the
decoupling is legible.

The camera is a **fixed-orientation top-down follow**: it tracks only the
player's XZ position at a constant height, with a small +Z back-offset for a
slight tilt (reads better than a pure orthographic-top view). The camera never
rotates with movement or aim.

## Controls

- **WASD** — move on world axes (independent of where you're aiming)
- **Mouse** — aim; the player nose faces the cursor, reticle marks the point
- No clicking / no pointer lock — the cursor stays visible (required for aim)

## Feel & difficulty notes

- **The decoupling feels right and immediate.** Strafing while aiming a fixed
  point (kiting) works exactly as a twin-stick shooter player expects. Facing is
  1-frame responsive since it's just `atan2` of the aim vector — no smoothing.
- **World-axis WASD is the honest twin-stick convention but can feel "off" the
  first second** because movement is not relative to where you're facing: press
  `W` and you always go screen-up regardless of aim. This is correct for the
  genre (Enter the Gungeon, Nuclear Throne) but players coming from camera-relative
  third-person controllers may briefly expect `W` = "forward where I aim."
- **Aim near the screen edges on a tilted camera is the weak spot.** Because the
  camera is slightly tilted rather than pure-top, the ground-plane raycast hits
  *further away* near the top of the screen than the bottom for the same pixel
  distance — so aim sensitivity isn't perfectly uniform across the screen. With a
  pure top-down ortho-ish view it would be uniform, but the scene reads flatter.
  This is the documented trade-off; a stronger top-down look would fix aim
  uniformity at the cost of depth.
- **Instant rotation (no turn rate) can look snappy/robotic.** A real shooter
  often adds a small turn-lerp for weight; here facing snaps for maximum
  responsiveness and to keep the decoupling unambiguous.

## Three.js gotchas

- **Do NOT use pointer lock for top-down aim.** Pointer lock hides the cursor and
  gives only relative `movementX/Y` deltas — useless for "where is the cursor in
  the world." Instead, read absolute `clientX/clientY`, convert to NDC against the
  canvas's `getBoundingClientRect()`, and `Raycaster.setFromCamera` + intersect a
  ground plane. The shared `InputController` is still used for keyboard state, but
  constructed with `lockOnClick: false` so it never grabs pointer lock.
- **`Raycaster.ray.intersectPlane` can return `null`** when the ray is parallel
  to the plane (or points away on a tilted camera). The frame loop guards this:
  on a miss it hides the reticle and **holds the last valid facing** instead of
  writing `NaN` into the rotation.
- **`atan2` argument order for +Z-forward facing.** The nose points along local
  +Z, and a Y-rotation of `atan2(dx, dz)` (note: `x` first, `z` second) aligns
  +Z with the aim vector. Using the usual `atan2(z, x)` would be off by 90°.
- **Reticle z-fighting.** A ring laid flat exactly on the ground flickers against
  the floor; lift it a hair (`RETICLE_LIFT`) above y = 0.
- **NDC must use the canvas rect, not the window**, or aim is offset by the
  gallery chrome / any canvas padding.
