# 09 — Co-op Carry

## What it demonstrates

Carrying a **dynamic** rigid body (a wooden plank) via **physics joints** — the
"co-op carry" mechanic from games like *Death Stranding*, *Moving Out*, or any
two-person furniture haul. The plank is not parented or kinematically pinned; it
is a free dynamic body whose two ends are attached to two carrier posts by
**Rapier spherical joints**. Spherical joints constrain position but leave
rotation free, so the plank genuinely swings and tilts under its own inertia.

The "co-op" angle is solved on a single machine: the player drives **carrier A**;
**carrier B auto-follows** A at a fixed side offset via a soft P-controller. The
follow is deliberately laggy, so when you turn or accelerate, B trails behind —
the plank then sways and tilts exactly like two people who aren't in step. A
`tilt NN°` readout in the HUD turns that sway into a number you can watch spike.

Press **Space** to detach/re-attach the joints (drop and pick the plank back up),
which is the clearest demonstration that the carry really is a constraint: when
the joints are removed the plank just falls and tumbles as a normal dynamic body.

## Controls

- **Click canvas** — lock the mouse (pointer lock)
- **WASD** — drive carrier A (camera-relative)
- **Mouse** — orbit the third-person follow camera
- **Space** — pick up / drop the plank (attach / detach the carry joints)
- **R** — reset carriers and plank to the start pose

## Feel & difficulty notes

- **The sway reads well and feels honest.** Walk in a straight line and the plank
  is steady; the moment you turn, carrier B lags, one end of the plank drags, and
  the whole board tilts and oscillates before settling. The tilt readout makes the
  "we're out of sync" moment legible.
- **Where it feels bad (intentionally honest):** the awkwardness is the point, but
  it tips into *frustrating* when you turn fast — B can overshoot and the plank
  whips, occasionally clipping a carrier before the joint pulls it back. Threading
  the slalom posts is fiddly because you have to anticipate B's lag a full beat
  ahead; there's no second human to read your intent, so it feels more like
  fighting a trailer than carrying with a partner.
- **Drop/pick is satisfying** but re-attaching snaps the plank back to the carry
  height instantly (the joints re-solve in one step) rather than easing in, which
  reads slightly abruptly.
- A single-driver "co-op" is inherently a compromise: you never get the *negotiated*
  feel of two real players, only the mechanical lag of a follower. It demonstrates
  the constraint physics faithfully; it does not fully capture the social feel.

## Three.js / Rapier gotchas

- **`@dimforge/rapier3d-compat` needs async init.** `await RAPIER.init()` (WASM)
  before constructing a `World`. The sample builds the world inside the `.then()`
  and guards with a `disposed` flag so a fast sample-switch during the await never
  builds a world or starts the rAF loop after teardown.
- **Spherical joints, not fixed.** `RAPIER.JointData.spherical(anchorOnPlank,
  anchorOnCarrier)` pins points but leaves rotation free — that's what lets the
  plank tilt. A `fixed` joint would rigidly lock the plank flat and kill the sway.
- **Lock carrier rotation** (`RigidBodyDesc.lockRotations()`) so the posts stay
  upright; otherwise the reaction torque from the plank topples them and the carry
  points wander. The plank's swing should come from carrier *translation* lag.
- **Fixed-timestep accumulator** (`1/60`, capped substeps) keeps the joints stable.
  Stepping with a raw variable `dt` makes spherical joints jitter and explode on a
  frame hitch. A clamp + max-substeps guard avoids the spiral-of-death after a stall.
- **Free the physics world on dispose.** `world.free()` releases the WASM-side
  bodies, colliders, and joints; without it the world leaks across sample switches.
  The rAF loop is cancelled and `world` is nulled, so no step runs after teardown.
- **Sync every frame**: copy each body's `translation()` + `rotation()` into the
  paired Three mesh's `position` / `quaternion`.
