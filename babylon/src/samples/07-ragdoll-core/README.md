# 07 — Ragdoll Core (Havok joints)

REPO-style physics jank: an articulated humanoid built from **11 capsule bodies**
wired together by **Havok physics joints**, dropped so it flops limp under
gravity. This is the **core only** — build + flop + clean teardown. The
click-to-punch and reset interactions are issue #26 (07b), which extends this
without touching the build/teardown machinery.

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
  `constraints[]`, `dispose()`) so 07b can map a clicked mesh back to its body to
  punch it, and tear the whole thing down + rebuild it to reset.

## Controls

| Input | Action |
|---|---|
| (none) | Passive ragdoll — just watch it topple and flop |
| Esc | Back to the gallery |

Camera is a fixed 3/4 `ArcRotateCamera` framing the figure — `attachControl` is
**not** called, so there is no orbit (see the feel note on depth below).

## Feel & difficulty notes

- **It flops, and it is honestly janky — that is the point.** The body topples
  from a slight forward lean (`SPAWN_TILT_RAD`), the limbs trail and slap the
  floor, and the hinge limits stop elbows/knees snapping the wrong way, so it
  reads as a *body* collapsing rather than a bag of disconnected sticks.
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
    can't orbit to read exactly how a limb folded. A real game would give the
    camera to the player; 07b's punch will have to live with the same fixed aim.
  - **Joint softness / jitter.** Like all constraint ragdolls the chain is
    slightly springy — under the initial impact joints flex a hair and limbs can
    buzz before settling. Havok's solver + the per-bone mass keep it stable, not
    rigid.
  - **Self-overlap at the joints.** Adjacent capsules share collider space at
    their anchor caps; Havok disables collision between constrained bodies by
    default (so they don't fight), which is exactly what we want here, but it means
    a limb can clip lightly through the torso in extreme poses.
  - **Passive only.** No muscles / pose-matching — it will never get up. 07b adds
    a reset to flop it again.
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
