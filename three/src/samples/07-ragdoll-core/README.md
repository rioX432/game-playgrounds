# 07 — Ragdoll Core

REPO-style physics jank: an articulated humanoid built from capsules wired
together by physics joints, dropped so it flops limp under gravity. This is the
**core** — construction + flop only. Interactions and a full reset UX land in
**#12**, so the ragdoll is kept modular and data-driven for extension.

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

## Controls

- **R** — drop the ragdoll again (rebuilds it at the spawn pose and lets it flop).

Camera is a fixed 3/4 view framing the figure — no orbit needed to read the flop.

## Feel & difficulty notes

- **It flops, and it is honestly janky — that is the point.** The body topples
  from a slight forward lean, the limbs trail and slap the floor, and the hinge
  limits stop elbows/knees from snapping the wrong way, so it reads as a *body*
  collapsing rather than a bag of disconnected sticks. That core "REPO ragdoll"
  feel is there.
- **Where it feels bad (documented honestly):**
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
    never get up. Press **R** to drop it again.

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
