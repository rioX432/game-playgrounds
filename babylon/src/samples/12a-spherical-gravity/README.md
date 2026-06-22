# 12a — Spherical Gravity + Walk-on-Sphere

Messenger / Super Mario Galaxy style "tiny planet". Gravity points toward the
planet's center instead of world-down, and the character's local up is glued to
the surface normal, so you can walk all the way around the sphere — over the
poles and across the underside — and never fall off.

This is the **core** half of the tiny-planet pair. Sample 12b adds environment
props and a polished, horizon-curving follow camera on top of this base.

## What it demonstrates

- **Radial gravity.** Each frame `up = normalize(pos − center)` and gravity
  accelerates the player along `−up` toward the center, not along world `−Y`.
- **Walk-on-sphere movement.** Tangent-plane stepping: the player moves along a
  persistent `forward` heading, then the new position is re-projected back onto
  the sphere at the same radius, so a straight step becomes a step along a great
  circle.
- **Surface-normal orientation.** The capsule's local Y is aligned to the
  surface normal and its local Z to the tangent heading via
  `Quaternion.FromLookDirectionLH(forward, up)` — no Euler angles, so there is no
  gimbal flip at the poles.
- **Manual kinematics, no physics body.** The whole controller is authored math
  on a `TransformNode`; Havok is not loaded here at all (see gotchas for why).

## Controls

| Input | Action |
|-------|--------|
| `W` / `S` | Walk forward / back along the surface |
| `A` / `D` | Turn the heading (tank-style) |
| `Space` | Jump (outward, away from the planet center) |

The camera is a fixed third-person follow rig; it has no manual control in 12a.

## Feel & difficulty notes

- **Feel: stable and predictable, but stiff.** Walking around the globe and over
  the poles works exactly as intended with zero drift or fall-off — the
  re-projection keeps you pinned to the surface frame after frame. Tank controls
  feel deliberate; turning then walking reads clearly because the lit gradient of
  the sphere gives a constant up-cue.
- **Where it feels bad — the camera.** This is the honest weak point of 12a. The
  follow camera snaps rigidly to `−forward` with no smoothing, so every `A`/`D`
  turn whips the whole view instantly and the horizon re-levels in one frame.
  It is functional but borderline nauseating on fast turns. Smoothing the camera
  position **and** its up-vector (so the horizon curves instead of snapping) is
  exactly what 12b exists to fix — 12a intentionally ships the unpolished version
  so the difference is visible.
- **Where it feels bad — no surface reference.** With only a bare sphere, slow
  walking on a smooth-lit patch can momentarily look like standing still. 12b's
  scattered props fix this; here the moving capsule + nose and the shading
  gradient are the only motion cues.
- **Tuning constants that matter:** `MOVE_SPEED` (5 u/s arc) and `TURN_SPEED`
  (2.4 rad/s) set the pace; `GRAVITY` (−22) and `JUMP_SPEED` (9) are lifted from
  the flat-floor sample 04 so the jump arc feels identical, just bent around a
  ball. `PLANET_RADIUS` (10) trades off how sharply the horizon curves against
  how "tiny" the planet reads.
- **Difficulty: medium.** The mechanic is just vector math, but getting the
  order right (recompute `up` → turn → walk+reproject → gravity → orient) and
  keeping the heading a clean tangent every frame is where the subtle bugs hide.

## Babylon-specific gotchas

- **Havok gravity is a single static world vector.** `scene.enablePhysics(g)`
  takes one global gravity and Havok only exposes a scalar per-body *gravity
  factor*, not a per-body gravity *direction*. Faking radial gravity on a dynamic
  body means fighting the solver with per-frame forces every tick, which feels
  jittery for a character. Manual kinematics is both simpler and smoother — and
  with no other physics actors, 12a skips Havok entirely.
- **Capsules are aligned to local Y.** `MeshBuilder.CreateCapsule` builds along
  the local Y axis, so aligning local Y to the surface normal is what makes the
  capsule "stand up" anywhere on the globe. The capsule center must sit at
  `center + up · (radius + halfHeight)`, not on the surface itself.
- **Orient from a look-direction, never Euler.** `Quaternion.FromLookDirectionLH`
  builds the orientation directly from `(forward, up)`. Driving yaw/pitch with
  Euler angles instead would gimbal-flip the moment you cross a pole.
- **Re-orthogonalize the heading every frame.** After a turn or a tangent step,
  `forward` drifts slightly off the tangent plane; subtracting its `up` component
  and renormalizing (with a defensive rebuild if it collapses onto `up`) keeps it
  a valid unit tangent and stops NaNs from leaking into the quaternion.
- **`camera.upVector` must be set for a tilted/inverted view.** A follow camera
  on the underside of the planet only looks right if its `upVector` tracks the
  surface normal; leaving it at world `+Y` would roll the view as you orbit.
