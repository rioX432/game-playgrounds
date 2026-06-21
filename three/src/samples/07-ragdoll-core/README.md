# 07 — Ragdoll

REPO-style physics jank: an articulated humanoid built from capsules wired
together by physics joints, dropped so it flops limp under gravity — then you
**click a limb to punch it** and **press R to reset** it to the spawn pose. The
ragdoll spec stays modular and data-driven; #12 added the interactions + reset on
top of the original core without touching the build/teardown machinery.

## What it demonstrates

- A **data-driven ragdoll spec**: two flat arrays — `BONES` (11 capsule bodies:
  pelvis, torso, head, upper/lower arms L/R, upper/lower legs L/R) and `JOINTS`
  (parent → child + anchors + kind/limits) — consumed by a single
  `buildRagdoll(world, spawn)` helper. Extend the arrays, not the build logic.
- **Two Rapier joint types** wiring the skeleton:
  - **Spherical (ball)** joints for shoulders, hips, and the neck/spine — free
    3-axis rotation, so limbs swing naturally.
  - **Revolute (hinge)** joints for elbows and knees, **with hard angular
    limits** (`limitsEnabled` + `limits` on the `JointData`) so they bend one way
    only and never fold backward into a pretzel.
- Fixed-timestep `world.step()` via an accumulator for stable joints, with each
  frame syncing every bone body's `translation()` + `rotation()` to its Three
  capsule mesh.
- Clean physics teardown: on sample switch the Rapier `world.free()`s (releasing
  all bodies/colliders/joints) and the step loop guards on a nulled `world` so it
  can never step a freed world (use-after-free).
- **Click-to-punch interaction**: a click raycasts from the camera through the
  cursor (`Raycaster.setFromCamera` with canvas-relative NDC) onto the bone
  meshes; the first hit's mesh is mapped back to its Rapier body and
  `applyImpulseAtPoint(impulse, hitPoint, true)` shoves that limb along the
  camera's view direction. Applying at the **hit point** (not the centre of mass)
  means off-centre clicks impart spin, so you can spin a limb or knock the whole
  figure over.
- **Reset** reuses the same `clearRagdoll` + `buildRagdoll` path as the original
  drop, so a fresh set of bodies replaces the old ones with zeroed velocities and
  no leaked bodies/colliders/joints.

## Controls

- **Click a limb** — punch it (impulse applied at the hit point, along the camera
  view direction). Clicking empty space does nothing.
- **R** — reset the ragdoll to the spawn pose (rebuilds it cleanly and lets it
  flop again from rest).

Camera is a fixed 3/4 view framing the figure — no orbit needed to read the flop.

## Feel & difficulty notes

- **It flops, and it is honestly janky — that is the point.** The body topples
  from a slight forward lean, the limbs trail and slap the floor, and the hinge
  limits stop elbows/knees from snapping the wrong way, so it reads as a *body*
  collapsing rather than a bag of disconnected sticks. That core "REPO ragdoll"
  feel is there.
- **The punch feels satisfyingly physical.** Clicking a limb and watching it
  snap away (and the rest of the chain follow through the joints) is the core
  loop and it lands — off-centre hits visibly spin the part because the impulse
  is applied at the hit point, not the centre of mass.
- **Where it feels bad (documented honestly):**
  - **No camera control, so depth is hard to judge.** The view is a fixed 3/4
    angle. The raycast picks the *nearest* mesh under the cursor, which is correct,
    but without orbiting you sometimes punch a limb you didn't mean to (a near arm
    occludes a far leg). A real game would give the camera to the player; here the
    fixed framing keeps the sample legible at the cost of precise aiming.
  - **A single fixed impulse magnitude.** `PUNCH_IMPULSE` is one constant, so
    every click hits equally hard — there's no charge-up or click-drag to vary
    force. It reads as "flick" not "haymaker"; tuning it up flings the figure
    off-screen, tuning it down feels weak. A force slider or hold-to-charge would
    add range but wasn't the core ask.
  - **Punch vs. settling.** Once the ragdoll is lying flat and asleep, a punch
    wakes it (`wakeUp = true`) and it reacts, but a light tap on a heavy bone
    (pelvis/torso) barely moves it — the mass from the capsule volume is doing its
    job, yet it can read as the click "not registering" until you hit a lighter
    limb.
  - **Spherical joints have NO cone limit in this build.** `@dimforge/rapier3d-compat`
    only exposes `limitsEnabled`/`limits` on *single-axis* joints (revolute,
    prismatic). Ball joints (shoulders/hips/neck) therefore rotate freely, so the
    head and limbs can occasionally over-rotate into mildly unnatural poses. We
    lean on **angular damping** to tame the worst of it; a true cone constraint
    would need a 6-DOF `generic` joint with angular limits (deferred to keep the
    core readable). This is the most visible jank.
  - **Joint softness / jitter.** Like all impulse-joint ragdolls, the chain is
    slightly springy: under fast collisions joints stretch a hair and limbs can
    buzz before settling. The fixed timestep + damping keep it stable, not rigid.
  - **Self-penetration.** Adjacent capsules interpenetrate at the joints
    (intentional — they share collider space at the anchor caps), and a limb can
    clip lightly through the torso in extreme poses. We do not disable
    self-collision per-pair in this core; #12 can add collision groups if needed.
  - No active muscles / pose-matching — it is a *passive* ragdoll, so it will
    never get up. Press **R** to reset it.

## Three.js / Rapier gotchas

- **Capsule axis & sizing match.** Rapier's `ColliderDesc.capsule(halfHeight,
  radius)` and Three's `CapsuleGeometry(radius, length)` both run the capsule
  along **local Y**, but Three's `length` is the *middle cylinder* section, so it
  must be `2 * halfHeight` for the mesh to match the collider. Get this wrong and
  the visual limbs are too short/long relative to the physics.
- **Joint anchors are in each body's LOCAL space.** Each anchor is placed at the
  capsule cap (`±halfHeight` along Y) where parent and child meet, not in world
  space.
- **Revolute limits are set on the `JointData`, not the joint instance.** Setting
  `data.limitsEnabled = true; data.limits = [min, max]` before
  `createImpulseJoint` is the data-driven path (`intoRaw()` applies them at
  creation), so the limits live in the spec.
- **Async WASM init race.** `RAPIER.init()` is async; the world is built only in
  the `.then`, guarded by a `disposed` flag so a fast sample-switch before init
  resolves never builds a world or starts a loop into a torn-down sample.
- **Free the world, then null it.** `world.free()` releases all Rapier memory;
  nulling the reference makes the still-pending `requestAnimationFrame` step a
  no-op, preventing a use-after-free crash on rapid sample switching.
- **Click picking: canvas-relative NDC, not window-relative.** The raycast maps
  the cursor to NDC using `canvas.getBoundingClientRect()` so it stays accurate
  when the canvas isn't full-window. The click handler bails if `world`/`bones`
  are null (clicks before WASM init or after dispose) and if the ray hits nothing,
  so it never punches a null body. The handler is a `canvas` listener and is
  removed in dispose alongside the `keydown` listener.
- **`applyImpulseAtPoint` is world-space.** Both the impulse vector and the point
  are world-space; the point comes straight from the Three raycast hit
  (`hit.point`), and the direction is `camera.getWorldDirection()`. Applying at
  the hit point (vs. `applyImpulse`, which acts at the centre of mass) is what
  produces the satisfying off-centre spin.
- **No new GPU resources to leak.** The interaction adds only a `Raycaster` and
  reused `Vector2`/`Vector3` scratch objects (plain math, not GPU buffers), so the
  dispose path's geometry/material cleanup is unchanged.
