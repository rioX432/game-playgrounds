# 07 — Ragdoll (Havok joints)

REPO-style physics jank: an articulated humanoid built from **11 capsule bodies**
wired together by **Havok physics joints**, dropped so it flops limp under
gravity — then you **click a limb to punch it** and **press R to reset** it to
the spawn pose. 07a built the data-driven core (build + flop + clean teardown);
issue #26 (07b) added the interactions + reset on top, reusing the same
build/teardown machinery without touching it.

## What it demonstrates

- A **data-driven ragdoll spec**: two flat arrays — `BONES` (11 capsule bodies:
  pelvis, torso, head, upper/lower arms L/R, upper/lower legs L/R) and `JOINTS`
  (parent → child + anchor pivots + kind + hinge limits) — consumed by a single
  `buildRagdoll(scene, spawn, material)` helper. **Extend the arrays, not the
  build logic.**
- **Two Havok v2 constraint types** wiring the skeleton:
  - **Ball-and-socket** for shoulders, hips, and the neck/spine —
    `new BallAndSocketConstraint(pivotA, pivotB, axisA, axisB, scene)` then
    `parentBody.addConstraint(childBody, c)`. Free 3-axis rotation, so limbs swing.
  - **Hinge with hard angular limits** for elbows and knees, built from a
    `Physics6DoFConstraint(params, limits, scene)`: we **LOCK** all three linear
    axes and the two perpendicular angular axes, and **LIMIT** the hinge axis
    (`ANGULAR_X`) to the bone's natural bend range, so elbows/knees bend **one way
    only** and never fold backward into a pretzel.
- **Babylon auto-steps physics and syncs body → mesh every frame.** Unlike the
  Three/Rapier sibling, there is **no manual fixed-timestep loop and no manual
  transform copy** — each `PhysicsAggregate` drives its mesh automatically once
  `scene.enablePhysics` is on.
- **Clean physics teardown** on sample switch: every constraint is disposed
  **before** the bodies, then each bone aggregate + mesh, then the floor body +
  mesh; the ragdoll ref is nulled and all setup is guarded by a `disposed` flag so
  a fast sample switch during the async Havok load never builds into a torn-down
  scene (no use-after-free).
- A **modular return structure** (`bones` by name, `byMesh` for picking,
  `constraints[]`, `dispose()`) so the interactions map a clicked mesh back to its
  body to punch it, and tear the whole thing down + rebuild it to reset.
- **Click-to-punch interaction**: a `pointerdown` raycasts the cursor with
  `scene.pick(x, y, predicate)` against **only** the bone meshes (the predicate is
  `(m) => ragdoll?.byMesh.has(m as Mesh)`); the picked mesh is mapped back to its
  bone, and `body.applyImpulse(impulse, hitPoint)` shoves that limb along the
  **camera view direction** (`scene.activeCamera.getForwardRay(1).direction`).
  Applying the impulse at the **hit point** (not the centre of mass) means
  off-centre clicks impart spin, so you can spin a limb or knock the figure over.
- **Reset (R)** reuses the same `buildRagdoll` + `Ragdoll.dispose()` path as the
  original drop: the current ragdoll is disposed (constraints → bodies) and a
  fresh set of bodies is rebuilt at the spawn pose, so velocities start zeroed and
  no bodies/colliders/constraints leak.

## Controls

| Input | Action |
|---|---|
| Click a limb | Punch it — impulse at the hit point, along the camera view direction. Clicking empty space does nothing. |
| R | Reset to the spawn pose (rebuilds cleanly and lets it flop again from rest) |
| Esc | Back to the gallery |

Camera is a fixed 3/4 `ArcRotateCamera` framing the figure — `attachControl` is
**not** called, so there is no orbit and **no pointer lock** (the cursor stays
visible for clicking; see the feel note on depth below).

## Feel & difficulty notes

- **It flops, and it is honestly janky — that is the point.** The body topples
  from a slight forward lean (`SPAWN_TILT_RAD`), the limbs trail and slap the
  floor, and the hinge limits stop elbows/knees snapping the wrong way, so it
  reads as a *body* collapsing rather than a bag of disconnected sticks.
- **The punch feels satisfyingly physical.** Clicking a limb and watching it snap
  away while the rest of the chain follows through the joints is the core loop and
  it lands — off-centre hits visibly spin the part, because the impulse is applied
  at the hit point, not the centre of mass.
- **Reset is instant and clean.** R tears the figure down and rebuilds it at the
  spawn pose, so it drops and flops again from rest — no drift, no leftover
  velocity, a good way to re-run the topple after you've punched it into a heap.
- **The hinge limits are the standout.** Because the elbow/knee `ANGULAR_X` axis
  is `LIMITED` to `[-2.2, 0]` rad while every other axis is `LOCKED`, those joints
  visibly bend toward the body and refuse to hyper-extend — a clear, readable
  difference from the free-swinging ball joints at the shoulders/hips/neck.
- **Tuning constants that shape the feel:** per-bone `MASS_*` (heavier core,
  lighter limbs, so it collapses like a weighted body), `BONE_FRICTION` (grippy so
  limbs settle instead of sliding forever), `BONE_RESTITUTION = 0` (no bounce —
  it slaps), `SPAWN_TILT_RAD` (the lean that guarantees it topples), and the
  `KNEE_LIMIT` / `ELBOW_LIMIT` bend ranges.
- **Where it feels bad (documented honestly):**
  - **No camera control, so depth is hard to judge.** The fixed 3/4 angle keeps
    the sample legible and removes an input model the core doesn't need, but you
    can't orbit to read exactly how a limb folded — and the punch lives with the
    same fixed aim. `scene.pick` picks the *nearest* bone under the cursor, which
    is correct, but without orbiting you sometimes punch a limb you didn't mean to
    (a near arm occludes a far leg). A real game would give the camera to the
    player; here the fixed framing trades precise aiming for legibility.
  - **A single fixed impulse magnitude.** `PUNCH_IMPULSE` is one constant, so
    every click hits equally hard — there's no charge-up or click-drag to vary
    force. It reads as "flick" not "haymaker"; tuning it up flings the figure
    offscreen, tuning it down feels weak. A force slider or hold-to-charge would
    add range but wasn't the core ask.
  - **Punch vs. settling.** Once the ragdoll is lying flat and asleep, a punch
    still wakes it (`applyImpulse` auto-wakes a sleeping Havok body) and it reacts,
    but a light hit on a heavy bone (pelvis/torso) barely moves it — the per-bone
    mass is doing its job, yet it can read as the click "not registering" until you
    hit a lighter limb.
  - **Joint softness / jitter.** Like all constraint ragdolls the chain is
    slightly springy — under the initial impact joints flex a hair and limbs can
    buzz before settling. Havok's solver + the per-bone mass keep it stable, not
    rigid.
  - **Self-overlap at the joints.** Adjacent capsules share collider space at
    their anchor caps; Havok disables collision between constrained bodies by
    default (so they don't fight), which is exactly what we want here, but it means
    a limb can clip lightly through the torso in extreme poses.
  - **Passive only.** No muscles / pose-matching — it will never get up on its
    own. Press **R** to reset it and flop it again.
- **Difficulty: high.** The hard part is the joint frames (local-space pivots at
  the meeting caps) and getting the 6-DoF lock/limit pattern right against the
  Havok plugin's exact semantics. Once the spec is correct the flop "just works"
  because Babylon owns the step + sync.

## Babylon-specific gotchas

- **Capsule sizing differs from Three/Rapier.** Babylon's
  `MeshBuilder.CreateCapsule({ height, radius })` takes the **TOTAL** capsule
  height (round caps **included**), and the capsule runs along **local Y**
  (`Vector3.Up()`). Three's `CapsuleGeometry(radius, length)` `length` is only the
  *middle cylinder*, and Rapier's `capsule(halfHeight, radius)` is the cylinder
  half-length — so the same figure uses different numbers in each engine. The
  `PhysicsShapeType.CAPSULE` aggregate derives its shape from the mesh, so mesh and
  collider match automatically.
- **The hinge rotation axis is `ANGULAR_X`, referenced from `axisA`/`axisB`.** In
  `PhysicsConstraintParameters`, `axisA`/`axisB` define the X reference frame for
  `LINEAR_X`/`ANGULAR_X` limits (and `perpAxisA`/`perpAxisB` the Y frame). So to
  hinge about local Z we pass that direction as `axisA`/`axisB` and limit
  `ANGULAR_X`. (Verified in `IPhysicsEnginePlugin.d.ts`.)
- **6-DoF limit semantics (verified in `havokPlugin.js`):** for a `SIX_DOF`
  constraint the plugin walks `limits[]`; an axis with `minLimit === 0 &&
  maxLimit === 0` is set to **LOCKED**, any other min/max is **LIMITED**, and any
  axis **omitted** from the array stays **FREE**. That is why the hinge lists all
  five locked axes explicitly plus the limited `ANGULAR_X`.
- **Constraint collision defaults to OFF.** The plugin reads
  `collisionEnabled = !!options.collision`, so omitting `collision` (or passing
  `false`) disables collision between the two constrained bodies — the correct
  default for a ragdoll whose adjacent capsules overlap at the joints. We pass
  `collision: false` explicitly on the 6-DoF params; `BallAndSocketConstraint` has
  no `collision` arg and inherits the same OFF default.
- **Babylon auto-steps + syncs.** With `scene.enablePhysics` on, you do **not**
  write a step loop or copy body transforms to meshes (the Rapier sample does
  both). Each `PhysicsAggregate` keeps its mesh in sync every frame.
- **Async WASM disposal race.** `getHavokPlugin()` resolves asynchronously; the
  world, floor, and ragdoll are built only inside the `.then`, guarded by a
  `disposed` flag so a fast sample switch before Havok finishes loading never
  builds into a torn-down scene.
- **Dispose order: constraints → bodies.** `Ragdoll.dispose()` disposes every
  constraint first, then each aggregate + mesh, so the engine never references a
  freed body. The floor aggregate + mesh and the bone material are freed in the
  sample's own dispose, and the ragdoll ref is nulled.
- **`applyImpulse(impulse, location)` is world-space and applies at a point.**
  `PhysicsBody.applyImpulse(impulse: Vector3, location: Vector3)` takes both the
  impulse vector and the application point in **world** space; the point comes
  straight from the `scene.pick` hit (`hit.pickedPoint`), and the direction is
  `scene.activeCamera.getForwardRay(1).direction`. Applying at the hit point (vs.
  the centre of mass) is what produces the satisfying off-centre spin, and the
  impulse implicitly **wakes a sleeping Havok body**, so a settled figure still
  reacts. (Signature verified in `@babylonjs/core/Physics/v2/physicsBody.d.ts`;
  see [the Babylon Physics v2 forces docs](https://doc.babylonjs.com/features/featuresDeepDive/physics/forces/).)
- **Picking only the bone meshes, re-read each event.** The `scene.pick`
  predicate is `(m) => ragdoll?.byMesh.has(m as Mesh)`, which re-reads the
  **current** `ragdoll` ref every click, so it follows a reset (the old `byMesh`
  is never captured stale) and returns `false` after dispose — clicking empty
  space, or clicking after teardown, punches nothing.
- **Reset rebuilds, it does not reposition.** R calls `ragdoll.dispose()` then
  `buildRagdoll(scene, SPAWN, boneMat)`, creating **fresh** bodies at the spawn
  pose with zeroed velocities. Because we never teleport a live dynamic body, the
  Babylon prestep-sync caveat (where moving a body's mesh needs `disablePreStep`)
  does not apply here.
- **Punch/reset listeners are window/canvas DOM listeners, removed in dispose.**
  The `pointerdown` (punch) listener is on the **canvas** and the `keydown`
  (reset) listener on `window`; both are pushed to `cleanups` and removed on
  sample switch, so nothing leaks across samples. The reset handler guards
  `e.repeat` so holding R rebuilds once, not every frame, and both handlers bail
  when `disposed` or `ragdoll` is null (clicks/keys before Havok loads or after
  teardown). The sample uses **no pointer lock** so the cursor stays visible to
  aim clicks.
