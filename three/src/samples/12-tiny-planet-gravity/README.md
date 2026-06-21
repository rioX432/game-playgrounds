# 12 — Tiny Planet Gravity

Messenger / Super Mario Galaxy "tiny planet": gravity pulls toward a sphere's
center, the player's up aligns to the surface normal, and you can walk all the
way around the globe — including across the underside.

The core controller (12a) is kinematic spherical gravity + walk-on-sphere. This
sample also includes 12b: **environment props** scattered radially over the
surface and a **polished, smoothed follow camera**. Camera feel is isolated in a
standalone `updateCamera` function; the props live in a self-owning `PropSet`.

## What it demonstrates

- **Spherical gravity, done kinematically (no physics engine).** Pure math: it
  is exact and leak-free, which is the right call for a mechanic this simple.
- **Up = surface normal.** `up = normalize(playerPos - center)` (center = origin),
  recomputed every frame. The capsule visibly tilts as it rounds the globe.
- **Walk-on-sphere.** A tangent basis `(right, up, forward)` is built on the
  sphere; W/S step along the tangent plane and the position is re-projected onto
  the sphere every frame (`setLength(radius + halfHeight)`) so the player never
  drifts off the surface.
- **Radially-oriented props.** Rocks (dodecahedra) and trees (stacked cones) are
  scattered at chosen (lat, lon) points — equator, both poles, and the underside.
  Each prop's local +Y is aligned to its surface normal via
  `quaternion.setFromUnitVectors((0,1,0), normal)`, so every prop stands *out of*
  the surface radially rather than all pointing world-up. They are static
  scenery (no physics) that gives the curvature a readable parallax reference.
- **Polished curved-horizon follow camera.** The camera position and the
  camera's own `up` are damped toward their targets with a frame-rate-independent
  blend (`t = 1 - exp(-rate*dt)`) so turning around the globe glides instead of
  snapping. The up tracks the surface normal so the horizon curves; without it
  the view flips as you cross the equator.

## Controls

- **W / S** — walk forward / back along the surface
- **A / D** — turn the heading left / right (rotates about the surface normal)
- **Space** — jump (radial impulse away from the center)

A/D-turn + W/S-forward (tank-style) was chosen over mouse-look because it is the
most legible control for orbiting a small sphere and it avoids pointer-lock and
pole-singularity issues that a fixed-axis mouse-yaw would introduce.

## Feel & difficulty notes (honest, incl. where it feels bad)

- **The smoothed camera is the big upgrade.** Damping the position and up makes
  rounding the globe feel fluid where the raw 12a camera snapped stiffly each
  frame. The props give the eye fixed landmarks, so the curvature now reads as
  *motion over a world* rather than an abstract tilt — the tiny-planet fantasy
  lands much harder.
- **Damping trades immediacy for smoothness.** Because the camera lags its
  target, hard direction changes (spamming A/D) feel slightly floaty and the
  framing trails the player for a beat. The rates are tuned to feel good at a
  walk; crank `CAMERA_POS_DAMP` / `CAMERA_UP_DAMP` up for a tighter, snappier
  (but stiffer) follow.
- **Tank controls are still a little stiff.** Turn-then-walk is deliberate and
  stable but less immediate than camera-relative WASD-strafe. The smoothing
  softens the *camera*, not the *controller*; the underlying movement is
  unchanged from 12a.
- **Mild disorientation near the "poles".** The heading is carried on the
  tangent plane and re-orthogonalized against the new up each frame, so there is
  no hard spin singularity — but passing directly over a pole can still rotate
  your apparent heading slightly as the frame swings around. Gentle, not a flip.
- **Props can be walked through.** They are pure scenery with no collision, so
  the capsule clips straight through a tree/rock. That is intentional for this
  mechanic spike (collision is its own problem), but it does break the illusion
  if you aim at one — the honest weak spot of the prop layer.
- **Jump is a clean radial pop** and re-lands predictably; downward radial
  velocity is zeroed on contact so there is no bounce.
- **Small planet = fast horizon.** With `PLANET_RADIUS = 8` the curvature is
  exaggerated on purpose so the mechanic is obvious; combined with camera
  damping it can read as slightly nauseating to some. Tune the radius up for a
  calmer feel.

## Three.js gotchas

- **`Quaternion.setFromUnitVectors(from, to)` is the clean way to stand a prop
  on a sphere.** With `from = (0,1,0)` and `to = surfaceNormal` it builds the
  shortest rotation that points local +Y outward — correct at the equator, both
  poles, and the underside with no special-casing (it handles the antiparallel
  case internally). Don't reach for Euler angles here; they'd reintroduce a pole
  singularity.
- **Cone geometry is centered on its height.** `ConeGeometry` straddles the
  origin along ±Y, so a trunk/leaf must be pushed out by *half* its own height
  (plus any part below it) before the whole tree is oriented to the normal.
- **Damp frame-rate-independently.** A naive `lerp(target, 0.1)` every frame is
  faster on a 144 Hz monitor than at 60 Hz. `t = 1 - exp(-rate*dt)` gives the
  same settling time regardless of framerate; `dt` is clamped so a stalled tab
  can't produce a giant blend.
- **Guard the camera-up lerp against antiparallel.** Lerping `up` toward a target
  that is nearly opposite passes through a near-zero vector that flips/​rolls the
  view. We snap the up when `dot(current, target) < -0.99` instead of
  interpolating through the degenerate zone.
- **`Matrix4.makeBasis(x, y, z)` takes the local axes as columns.** The capsule's
  local +Y is its up and local −Z is its forward, so the basis is built from
  `(right, up, −forward)` to make the capsule face the heading. Getting the sign
  of the forward column wrong makes the capsule face backward.
- **`camera.up` must be reset on dispose.** We set `camera.up` to the (smoothed)
  surface normal every frame; the harness reuses a fresh camera per sample but we
  still reset it to `(0, 1, 0)` in dispose so nothing leaks a tilted up into the
  next sample.
- **Re-project the position, don't trust the integrator.** Tangential stepping
  along a flat plane moves you slightly *off* the sphere; `setLength` on the
  grounded frame is the cheap, exact fix that keeps the player glued down.
- **Carry the tangent basis across frames.** Rebuilding `forward` from a fixed
  world axis every frame spins violently near that axis' poles. Carrying the
  previous forward and re-orthogonalizing against the new up keeps it continuous.
- **The planet IS the ground** — this sample does not use `createGround`; the
  sphere's surface is the floor, and props are placed directly on it.
- **Props own their GPU resources.** Geometries and (shared) materials are
  tracked in the `PropSet` and disposed exactly once on sample switch — no leak,
  even though many props reuse the same geometry/material.
</content>
</invoke>
