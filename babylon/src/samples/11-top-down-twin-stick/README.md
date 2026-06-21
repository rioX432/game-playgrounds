# 11 — Top-Down Twin-Stick Movement

## What it demonstrates

The classic **twin-stick** decoupling: the player's **movement** direction and
its **facing/aim** direction are independent.

- **Movement** is driven by WASD on fixed **world axes** (W = up/−Z, S = down/+Z,
  A = −X, D = +X), normalized so diagonals aren't faster. The rig's XZ is nudged
  each frame by `dir * MOVE_SPEED * dt`.
- **Facing** is driven by the **absolute mouse cursor**. Every frame the cursor's
  screen position is ray-cast against the ground mesh via Babylon's
  `scene.pick(scene.pointerX, scene.pointerY, predicate)` to get a world-space aim
  point (`hit.pickedPoint`), and the rig rotates its Y to face it.

Because they're separate inputs, you can strafe left while aiming right — hold
`D` and sweep the mouse the other way and the blue disc slides one way while the
yellow nose tracks the cursor. A red ground reticle marks the aim point so the
decoupling is legible.

The camera is a **fixed-orientation top-down follow** (`UniversalCamera`, no
`attachControl`): it tracks only the player's XZ at a constant height, with a
small +Z back-offset for a slight tilt (reads better than a pure orthographic-top
view). The camera never rotates with movement or aim.

## Controls

| Input | Action |
|---|---|
| **W / A / S / D** | Move on world axes (independent of where you're aiming) |
| **Mouse** | Aim; the player nose faces the cursor, reticle marks the point |
| — | No clicking / no pointer lock — the cursor stays visible (required for aim) |

## Feel & difficulty notes

- **The decoupling feels right and immediate.** Strafing while aiming a fixed
  point (kiting) works exactly as a twin-stick shooter player expects. Facing is
  1-frame responsive since it's just `atan2` of the aim vector — no smoothing.
- **World-axis WASD is the honest twin-stick convention but feels "off" for the
  first second** because movement is not relative to where you're facing: press
  `W` and you always go screen-up regardless of aim. Correct for the genre (Enter
  the Gungeon, Nuclear Throne), but players coming from camera-relative
  third-person controllers may briefly expect `W` = "forward where I aim."
- **Aim near the screen edges on a tilted camera is the weak spot.** Because the
  camera is slightly tilted rather than pure-top, the ground pick hits *further
  away* near the top of the screen than the bottom for the same pixel distance —
  so aim sensitivity isn't perfectly uniform across the screen. A pure top-down
  view would make it uniform at the cost of depth. Documented trade-off.
- **Instant rotation (no turn rate) can look snappy/robotic.** A real shooter
  often adds a small turn-lerp for weight; here facing snaps for maximum
  responsiveness and to keep the decoupling unambiguous.
- **Difficulty: low.** The mechanic is a few lines once the aim raycast and the
  fixed camera are in place — the subtlety is all in the feel, not the code.

## Babylon-specific gotchas

- **Use `scene.pick`, not pointer lock, for top-down aim.** Pointer lock hides the
  cursor and gives only relative `movementX/Y` deltas — useless for "where is the
  cursor in the world." We pass `{ pointerLock: false }` to the shared
  `createInput` so it adds **no** pointer-lock listener and never grabs the
  pointer; the cursor stays visible. `scene.pick(scene.pointerX, scene.pointerY,
  predicate)` reads Babylon's already-tracked absolute pointer coords — no manual
  `getBoundingClientRect()` / NDC math needed.
- **`scene.pick` can miss.** When the cursor is off the ground mesh,
  `hit.pickedPoint` is null. The frame loop guards this: on a miss it hides the
  reticle (`setEnabled(false)`) and **holds the last valid facing** instead of
  writing `NaN` into the rotation.
- **`atan2` argument order for +Z-forward facing.** Babylon is **left-handed**; a
  mesh's local +Z is its forward. The nose is offset on local +Z, so a Y-rotation
  of `atan2(dx, dz)` (note: `x` first, `z` second) points it at the aim vector.
  The usual `atan2(z, x)` would be off by 90°.
- **Exclude the reticle from the aim pick.** The reticle lives on the ground at
  the cursor; set `reticle.isPickable = false` so it can never intercept its own
  aim ray (the predicate already filters to the ground, but this is belt-and-
  suspenders and keeps it out of all picks).
- **Reticle z-fighting.** A ring laid flat exactly on the ground flickers against
  the floor; lift it a hair (`RETICLE_LIFT`) above y = 0.
- **No `attachControl` on the camera.** `attachControl` would let the camera be
  dragged/rotated by the pointer and fight the fixed top-down framing. We drive
  `camera.position` + `camera.setTarget` manually every frame instead.
