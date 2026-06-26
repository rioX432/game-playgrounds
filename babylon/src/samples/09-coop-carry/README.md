# 09 — Co-op Carry (Havok joints)

## What it demonstrates

Carrying a **dynamic** rigid body (a wooden plank) via **physics joints** — the
"co-op carry" mechanic from games like *Death Stranding*, *Moving Out*, or any
two-person furniture haul. The plank is not parented or kinematically pinned; it
is a free dynamic body (`mass > 0`) whose two ends are attached to two carrier
posts by Havok **`BallAndSocketConstraint`s**. A ball-and-socket constraint pins
a pivot point but leaves rotation free, so the plank genuinely swings and tilts
under its own inertia.

The "co-op" angle is solved on a single machine: the player drives **carrier A**;
**carrier B auto-follows** A at a fixed side offset via a soft P-controller. The
follow is deliberately laggy, so when you turn or accelerate, B trails behind —
the plank then sways and tilts exactly like two people who aren't in step. A
`tilt NN°` readout below the gallery card turns that sway into a number you can
watch spike.

Both carriers are `PhysicsMotionType.ANIMATED` (kinematic) bodies: we move them
each frame with `body.setTargetTransform(position, rotation)` and they drag the
jointed plank through the constraints **without** being pushed back or toppling
(an ANIMATED body pulls on constraints but is not itself affected by them).

Press **Space** to detach/re-attach the joints (drop and pick the plank back up),
which is the clearest demonstration that the carry really is a constraint: when
the constraints are disposed the plank just falls and tumbles as a normal dynamic
body onto the floor.

## Controls

| Input | Action |
|---|---|
| **WASD** | Drive carrier A (heading-relative) |
| **Mouse** | Look — click the canvas to lock the pointer |
| **Space** | Drop / re-attach the plank (dispose / recreate the carry constraints) |
| **R** | Reset carriers and plank to the start pose (and re-attach) |
| **Esc** | Release the pointer |

## Feel & difficulty notes

- **The sway reads well and feels honest.** Walk in a straight line and the plank
  is steady; the moment you turn, carrier B lags, one end of the plank drags, and
  the whole board tilts and oscillates before settling. The `tilt NN°` readout
  makes the "we're out of sync" moment legible as a spiking number.
- **Where it feels bad (intentionally honest):** the awkwardness is the point, but
  it tips into *frustrating* when you turn fast — B overshoots and the plank whips,
  occasionally clipping a carrier before the joint pulls it back. There is no
  second human to read your intent, so it feels more like dragging a trailer than
  carrying *with* a partner.
- **Drop/pick is satisfying** but re-attaching snaps the plank back to the carry
  height in a single solver step rather than easing in, which reads slightly
  abruptly.
- A single-driver "co-op" is inherently a compromise: you never get the
  *negotiated* feel of two real players, only the mechanical lag of a follower. It
  demonstrates the constraint physics faithfully; it does not fully capture the
  social feel. (Networking/real multiplayer is out of scope — see *Won't Do*.)
- The follow gain (`CARRIER_B_FOLLOW_GAIN`) and move speed are the two constants
  that shape feel: higher gain = tighter, less sway; lower = more drama and more
  whip.
- **Cross-engine note (deliberate divergence, kept on purpose):** these carriers
  are `ANIMATED` (kinematic) — they pull on the joints but are *not* pushed back
  by them, so the plank can never shove a carrier off course. The Three.js and
  Bevy peers instead use **dynamic, rotation-locked** carriers that the plank
  *can* perturb. We keep Babylon's animated approach rather than unifying: it is
  exactly the kind of engine-idiom contrast this playground exists to surface
  (Havok `setTargetTransform` kinematic drive vs a dynamic velocity-driven body),
  and both produce the same out-of-sync sway. See `COMPARISON.md` §4.

## Babylon-specific gotchas

- **Async Havok WASM vs. disposal race.** `createHavokPlugin()` loads the runtime on
  demand; everything (world, bodies, constraints, the per-frame observer) is built
  inside the `.then()` and guarded by a `disposed` flag so a fast sample switch
  during the await never builds physics or starts updating after teardown.
- **Ball-and-socket, not lock.** `new BallAndSocketConstraint(pivotA, pivotB,
  axisA, axisB, scene)` pins pivot points but leaves rotation free — that's what
  lets the plank tilt. `pivotA` is in body A's (the plank's) local frame and
  `pivotB` in body B's (the carrier's) frame. A `LockConstraint` would rigidly
  weld the plank flat and kill the sway.
- **Attach via `plankBody.addConstraint(carrierBody, constraint)`** — the body the
  method is called on is "body A" (matching `pivotA`/`axisA`). Detach by calling
  `constraint.dispose()`, which removes it from the engine so the plank falls;
  re-attach recreates fresh constraints (they re-solve in one step, hence the
  abrupt snap noted above).
- **ANIMATED carriers, DYNAMIC plank.** After building each carrier
  `PhysicsAggregate`, call `body.setMotionType(PhysicsMotionType.ANIMATED)` and
  drive it with `setTargetTransform` each frame. ANIMATED bodies stay exactly
  where you put them (upright by construction) and pull on constraints without
  taking the reaction. The plank is a normal dynamic aggregate (`mass > 0`).
- **Side-effect imports matter.** `cylinderBuilder` and `boxBuilder` must be
  imported for their side effects or `MeshBuilder.CreateCylinder/CreateBox`
  silently no-op; `@babylonjs/core/Physics/physicsEngineComponent` wires physics
  into the scene.
- **Own your DOM + physics cleanup.** The tilt readout is a DOM node appended to
  the stage (outside the scene graph), so it is removed in dispose along with the
  shared input/HUD; the constraints and aggregates created in the async block are
  disposed there too.

Verified against the installed `@babylonjs/core` 7.54.3 type definitions
(`Physics/v2/physicsConstraint.d.ts`, `physicsBody.d.ts`,
`IPhysicsEnginePlugin.d.ts`) and the
[Babylon.js Physics V2 rigid-bodies docs](https://doc.babylonjs.com/features/featuresDeepDive/physics/rigidBodies)
for the ANIMATED motion-type / `setTargetTransform` pattern.
