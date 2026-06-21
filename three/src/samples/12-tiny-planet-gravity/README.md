# 12 — Tiny Planet Gravity (sub-mechanic 12a)

Messenger / Super Mario Galaxy "tiny planet": gravity pulls toward a sphere's
center, the player's up aligns to the surface normal, and you can walk all the
way around the globe — including across the underside.

This is the **core controller (12a)**. Issue #14 (12b) extends this same sample
with environment props, a polished follow camera, and the final README. The
follow-camera logic lives in a standalone `updateCamera` function so #14 can swap
it out without touching the controller.

## What it demonstrates

- **Spherical gravity, done kinematically (no physics engine).** Pure math: it
  is exact and leak-free, which is the right call for a mechanic this simple.
- **Up = surface normal.** `up = normalize(playerPos - center)` (center = origin),
  recomputed every frame. The capsule visibly tilts as it rounds the globe.
- **Walk-on-sphere.** A tangent basis `(right, up, forward)` is built on the
  sphere; W/S step along the tangent plane and the position is re-projected onto
  the sphere every frame (`setLength(radius + halfHeight)`) so the player never
  drifts off the surface.
- **Curved-horizon follow camera.** The camera's own `up` is set to the surface
  normal so the horizon curves and the "tiny planet" reads; without it the view
  flips as you cross the equator.

## Controls

- **W / S** — walk forward / back along the surface
- **A / D** — turn the heading left / right (rotates about the surface normal)
- **Space** — jump (radial impulse away from the center)

A/D-turn + W/S-forward (tank-style) was chosen over mouse-look because it is the
most legible control for orbiting a small sphere and it avoids pointer-lock and
pole-singularity issues that a fixed-axis mouse-yaw would introduce.

## Feel & difficulty notes (honest, incl. where it feels bad)

- **Walking the full globe feels great** — the tilt + curved horizon sell the
  tiny-planet fantasy immediately, and the controller is rock-solid on the
  re-projection so you never slide off.
- **Tank controls feel a little stiff.** Turn-then-walk is deliberate and stable
  but less immediate than direct WASD-strafe relative to the camera. #14's
  polished camera may revisit this; for the core it trades snappiness for
  legibility and stability.
- **Mild disorientation near the "poles" relative to the start axis.** Because
  the heading is *carried* on the tangent plane and re-orthogonalized against the
  new up each frame (rather than rebuilt from a fixed world axis), there is no
  hard spin singularity — but passing directly over a pole can still rotate your
  apparent heading slightly as the frame swings around. It is gentle, not a
  flip; documented here as the one residual weirdness.
- **Jump is a clean radial pop** and re-lands predictably; downward radial
  velocity is zeroed on contact so there is no bounce.
- **Small planet = fast horizon.** With `PLANET_RADIUS = 8` the curvature is
  exaggerated on purpose so the mechanic is obvious; it makes the camera swing
  feel quick, which some will read as slightly nauseating. Tune the radius up for
  a calmer feel.

## Three.js gotchas

- **`Matrix4.makeBasis(x, y, z)` takes the local axes as columns.** The capsule's
  local +Y is its up and local −Z is its forward, so the basis is built from
  `(right, up, −forward)` to make the capsule face the heading. Getting the sign
  of the forward column wrong makes the capsule face backward.
- **`camera.up` must be reset on dispose.** We set `camera.up` to the surface
  normal every frame; the harness reuses a fresh camera per sample but we still
  reset it to `(0, 1, 0)` in dispose so nothing leaks a tilted up into the next
  sample.
- **Re-project the position, don't trust the integrator.** Tangential stepping
  along a flat plane moves you slightly *off* the sphere; `setLength` on the
  grounded frame is the cheap, exact fix that keeps the player glued down.
- **Carry the tangent basis across frames.** Rebuilding `forward` from a fixed
  world axis every frame spins violently near that axis' poles. Carrying the
  previous forward and re-orthogonalizing against the new up keeps it continuous.
- **The planet IS the ground** — this sample does not use `createGround`; the
  sphere's surface is the floor.
