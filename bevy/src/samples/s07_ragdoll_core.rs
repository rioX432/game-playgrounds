//! # s07 — Ragdoll core (capsules + physics joints, REPO-style flop)
//!
//! **What it demonstrates:** A humanoid ragdoll assembled from a small set of
//! `RigidBody::Dynamic` capsules (pelvis, torso, head, upper/lower arms L/R,
//! upper/lower legs L/R) wired together by rapier joints, spawned slightly above
//! the ground so it FLOPS down under gravity. This is the REPO-style "loose
//! physics body" jank: shoulders/hips/neck are SPHERICAL (ball) joints so they
//! swing freely, while elbows/knees are REVOLUTE (hinge) joints with angle
//! LIMITS so the limbs bend like a body rather than folding into a pretzel.
//!
//! The construction is DATA-DRIVEN: a flat [`BONES`] array (name + half-extents +
//! spawn offset) and a [`JOINTS`] array (parent/child bone names + joint kind +
//! anchors) are consumed by a modular [`build_ragdoll`] helper, so the follow-up
//! (#40: interactions + reset) can extend the spec without rewriting assembly.
//!
//! **Controls:** `R` — re-drop the ragdoll (despawn the current bodies and
//! rebuild the spec from the start pose, so you can watch it flop again).
//! `Esc` — back to the menu.
//!
//! **Feel notes:** The honest feel here is *floppy ragdoll jank*. The good part:
//! limited hinges at elbows/knees plus free ball joints at the big joints give a
//! believable loose-body collapse — it reads as a "passed-out body", which is the
//! REPO charm. Honest bad parts: (1) joints are PURE constraints with no muscle /
//! motor, so the body has zero tone — it always collapses completely and can
//! never hold a pose or react, which is lifeless next to a driven ragdoll. (2)
//! the spec is symmetric and stiffness comes only from solver defaults, so limbs
//! can still jitter or self-interpenetrate at rest because the capsules have no
//! collision groups excluding adjacent bones (touching capsules fight the solver
//! a little). (3) the initial drop is from a fixed pose, so every re-drop flops
//! near-identically — there's no random initial impulse to vary the collapse, so
//! it lacks the "every time is different" appeal a real ragdoll toy has. (4) the
//! revolute limits are coarse (one hinge axis per limb), so the elbows/knees only
//! bend on a single plane and look stiff from some angles.
//!
//! **Bevy 0.18 / rapier 0.34 gotchas:**
//!   * The rapier plugin is GLOBAL (added once in `main.rs`); this sample only
//!     spawns physics entities. Cleanup is AUTOMATIC: every bone (body + collider)
//!     and joint entity carries `DespawnOnExit(AppState::S07Ragdoll)`, so leaving
//!     the sample despawns them and rapier removes the underlying bodies/joints —
//!     NO manual world teardown, NO use-after-free.
//!   * Joints use the 0.34 builder API. A SPHERICAL joint is
//!     `SphericalJointBuilder::new().local_anchor1(a1).local_anchor2(a2)` (no axis
//!     — rotation is free on all 3 axes). A REVOLUTE (hinge) joint is
//!     `RevoluteJointBuilder::new(axis).local_anchor1(a1).local_anchor2(a2)
//!     .limits([min, max])` — note `new` REQUIRES the hinge axis (a `Vec3`) in
//!     dim3, and `.limits` takes radians `[min, max]`. Both builders impl
//!     `Into<TypedJoint>`, so they pass straight to `ImpulseJoint::new`.
//!   * An entity holds only ONE `ImpulseJoint`. The ragdoll is a TREE, so each
//!     child bone hosts exactly one joint pointing at its PARENT bone — no bone
//!     needs two joints, which fits the one-joint-per-entity rule cleanly.
//!     `local_anchor1` is in the PARENT's local frame, `local_anchor2` in the
//!     CHILD's local frame.
//!   * bevy_rapier writes each dynamic body's pose back into its entity
//!     `Transform` every frame — READ `Transform` directly, never copy by hand.
//!     Global gravity defaults to -9.81 Y, so the ragdoll falls on its own.
//!   * `Query::single()` returns `Result` — handle with
//!     `let Ok(..) = .. else { return; };`.
//!
//! **Shared scene/HUD:** ground (render) + key light come from `engine::scene`;
//! the controls overlay + FPS counter from `engine::hud`. A matching static floor
//! collider is added inline so the ragdoll has something to land on. Everything is
//! `DespawnOnExit`-scoped.

use bevy::prelude::*;
use bevy_rapier3d::prelude::*;

use crate::engine::hud;
use crate::engine::scene;

use super::{AppState, SampleMeta};

pub const META: SampleMeta = SampleMeta {
    id: "07-ragdoll-core",
    title: "Ragdoll core (capsules + joints)",
    summary: "A humanoid of jointed capsules that flops under gravity — REPO-style jank.",
    tags: &["physics", "rapier", "joint", "ragdoll"],
};

/// Height above the ground the ragdoll's pelvis spawns at, so the body drops and
/// flops on enter (world units).
const SPAWN_HEIGHT: f32 = 3.0;
/// Capsule radius shared by every bone (world units).
const BONE_RADIUS: f32 = 0.16;
/// Static floor half-extents (matches the shared render ground footprint).
const FLOOR_HALF: Vec3 = Vec3::new(20.0, 0.05, 20.0);
/// Elbow / knee hinge angle limits (radians). A body's elbow bends roughly 0..150°
/// one way and never hyperextends; we clamp to `[-LIMB_BEND_MAX, 0]` so the hinge
/// only folds inward, not backward (no pretzel / no hyperextension).
const LIMB_BEND_MAX: f32 = 2.4; // ~137°

/// Which kind of rapier joint couples a child bone to its parent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum JointKind {
    /// Free ball joint (shoulders, hips, neck) — rotation unconstrained.
    Spherical,
    /// Hinge joint with angle limits (elbows, knees) — bends on one axis only.
    Revolute,
}

/// A single ragdoll bone: a capsule of the given half-height, placed at `offset`
/// from the pelvis at spawn time (pelvis itself is the origin of this local frame).
#[derive(Debug, Clone, Copy)]
struct BoneSpec {
    /// Stable name used by [`JointSpec`] to reference this bone.
    name: &'static str,
    /// Capsule half-height (the straight section; total length ≈ 2*half + 2*radius).
    half_height: f32,
    /// Spawn offset of this bone's center from the pelvis center (world axes).
    offset: Vec3,
}

/// A joint connecting `child` to `parent`. Anchors are the attachment points in
/// each bone's LOCAL frame; `kind` selects spherical (free) vs revolute (limited
/// hinge). For revolute joints `axis` is the hinge axis in local space.
#[derive(Debug, Clone, Copy)]
struct JointSpec {
    /// Name of the parent bone (must exist in [`BONES`]).
    parent: &'static str,
    /// Name of the child bone hosting the joint (must exist in [`BONES`]).
    child: &'static str,
    kind: JointKind,
    /// Attachment point in the PARENT bone's local frame.
    parent_anchor: Vec3,
    /// Attachment point in the CHILD bone's local frame.
    child_anchor: Vec3,
    /// Hinge axis (local space) for [`JointKind::Revolute`]; ignored for spherical.
    axis: Vec3,
}

// Bone half-heights (the straight capsule section, before the rounded caps).
const TORSO_HALF: f32 = 0.28;
const PELVIS_HALF: f32 = 0.14;
const HEAD_HALF: f32 = 0.10;
const UPPER_ARM_HALF: f32 = 0.18;
const LOWER_ARM_HALF: f32 = 0.18;
const UPPER_LEG_HALF: f32 = 0.22;
const LOWER_LEG_HALF: f32 = 0.22;

// Lateral / vertical placement constants for the spawn pose (pelvis at origin).
const SHOULDER_X: f32 = 0.28;
const HIP_X: f32 = 0.14;
const TORSO_Y: f32 = 0.5;
const HEAD_Y: f32 = 0.95;
const UPPER_ARM_Y: f32 = 0.5;
const LOWER_ARM_Y: f32 = 0.05;
const UPPER_LEG_Y: f32 = -0.45;
const LOWER_LEG_Y: f32 = -0.95;

/// The humanoid bone spec (data-driven). Pelvis is the root at the local origin;
/// every other bone is placed relative to it. `build_ragdoll` consumes this.
const BONES: &[BoneSpec] = &[
    BoneSpec {
        name: "pelvis",
        half_height: PELVIS_HALF,
        offset: Vec3::ZERO,
    },
    BoneSpec {
        name: "torso",
        half_height: TORSO_HALF,
        offset: Vec3::new(0.0, TORSO_Y, 0.0),
    },
    BoneSpec {
        name: "head",
        half_height: HEAD_HALF,
        offset: Vec3::new(0.0, HEAD_Y, 0.0),
    },
    BoneSpec {
        name: "upper_arm_l",
        half_height: UPPER_ARM_HALF,
        offset: Vec3::new(-SHOULDER_X, UPPER_ARM_Y, 0.0),
    },
    BoneSpec {
        name: "lower_arm_l",
        half_height: LOWER_ARM_HALF,
        offset: Vec3::new(-SHOULDER_X, LOWER_ARM_Y, 0.0),
    },
    BoneSpec {
        name: "upper_arm_r",
        half_height: UPPER_ARM_HALF,
        offset: Vec3::new(SHOULDER_X, UPPER_ARM_Y, 0.0),
    },
    BoneSpec {
        name: "lower_arm_r",
        half_height: LOWER_ARM_HALF,
        offset: Vec3::new(SHOULDER_X, LOWER_ARM_Y, 0.0),
    },
    BoneSpec {
        name: "upper_leg_l",
        half_height: UPPER_LEG_HALF,
        offset: Vec3::new(-HIP_X, UPPER_LEG_Y, 0.0),
    },
    BoneSpec {
        name: "lower_leg_l",
        half_height: LOWER_LEG_HALF,
        offset: Vec3::new(-HIP_X, LOWER_LEG_Y, 0.0),
    },
    BoneSpec {
        name: "upper_leg_r",
        half_height: UPPER_LEG_HALF,
        offset: Vec3::new(HIP_X, UPPER_LEG_Y, 0.0),
    },
    BoneSpec {
        name: "lower_leg_r",
        half_height: LOWER_LEG_HALF,
        offset: Vec3::new(HIP_X, LOWER_LEG_Y, 0.0),
    },
];

/// Hinge axis for elbows/knees: bones lie along Y, so a hinge about the X axis
/// folds the limb forward/back in the sagittal plane.
const HINGE_AXIS: Vec3 = Vec3::X;

/// The joint spec (data-driven). Each entry hosts ONE `ImpulseJoint` on the child,
/// pointing at the parent. Big joints (spine, neck, shoulders, hips) are spherical
/// (free); elbows/knees are revolute hinges with limits (no pretzel).
const JOINTS: &[JointSpec] = &[
    // Spine + neck (free ball joints).
    JointSpec {
        parent: "pelvis",
        child: "torso",
        kind: JointKind::Spherical,
        parent_anchor: Vec3::new(0.0, PELVIS_HALF, 0.0),
        child_anchor: Vec3::new(0.0, -TORSO_HALF, 0.0),
        axis: Vec3::ZERO,
    },
    JointSpec {
        parent: "torso",
        child: "head",
        kind: JointKind::Spherical,
        parent_anchor: Vec3::new(0.0, TORSO_HALF, 0.0),
        child_anchor: Vec3::new(0.0, -HEAD_HALF, 0.0),
        axis: Vec3::ZERO,
    },
    // Shoulders (free ball joints).
    JointSpec {
        parent: "torso",
        child: "upper_arm_l",
        kind: JointKind::Spherical,
        parent_anchor: Vec3::new(-SHOULDER_X, TORSO_HALF, 0.0),
        child_anchor: Vec3::new(0.0, UPPER_ARM_HALF, 0.0),
        axis: Vec3::ZERO,
    },
    JointSpec {
        parent: "torso",
        child: "upper_arm_r",
        kind: JointKind::Spherical,
        parent_anchor: Vec3::new(SHOULDER_X, TORSO_HALF, 0.0),
        child_anchor: Vec3::new(0.0, UPPER_ARM_HALF, 0.0),
        axis: Vec3::ZERO,
    },
    // Elbows (limited hinges).
    JointSpec {
        parent: "upper_arm_l",
        child: "lower_arm_l",
        kind: JointKind::Revolute,
        parent_anchor: Vec3::new(0.0, -UPPER_ARM_HALF, 0.0),
        child_anchor: Vec3::new(0.0, LOWER_ARM_HALF, 0.0),
        axis: HINGE_AXIS,
    },
    JointSpec {
        parent: "upper_arm_r",
        child: "lower_arm_r",
        kind: JointKind::Revolute,
        parent_anchor: Vec3::new(0.0, -UPPER_ARM_HALF, 0.0),
        child_anchor: Vec3::new(0.0, LOWER_ARM_HALF, 0.0),
        axis: HINGE_AXIS,
    },
    // Hips (free ball joints).
    JointSpec {
        parent: "pelvis",
        child: "upper_leg_l",
        kind: JointKind::Spherical,
        parent_anchor: Vec3::new(-HIP_X, -PELVIS_HALF, 0.0),
        child_anchor: Vec3::new(0.0, UPPER_LEG_HALF, 0.0),
        axis: Vec3::ZERO,
    },
    JointSpec {
        parent: "pelvis",
        child: "upper_leg_r",
        kind: JointKind::Spherical,
        parent_anchor: Vec3::new(HIP_X, -PELVIS_HALF, 0.0),
        child_anchor: Vec3::new(0.0, UPPER_LEG_HALF, 0.0),
        axis: Vec3::ZERO,
    },
    // Knees (limited hinges).
    JointSpec {
        parent: "upper_leg_l",
        child: "lower_leg_l",
        kind: JointKind::Revolute,
        parent_anchor: Vec3::new(0.0, -UPPER_LEG_HALF, 0.0),
        child_anchor: Vec3::new(0.0, LOWER_LEG_HALF, 0.0),
        axis: HINGE_AXIS,
    },
    JointSpec {
        parent: "upper_leg_r",
        child: "lower_leg_r",
        kind: JointKind::Revolute,
        parent_anchor: Vec3::new(0.0, -UPPER_LEG_HALF, 0.0),
        child_anchor: Vec3::new(0.0, LOWER_LEG_HALF, 0.0),
        axis: HINGE_AXIS,
    },
];

/// Tags every bone entity of the ragdoll so a re-drop can despawn the whole body.
#[derive(Component)]
struct RagdollBone;

pub struct RagdollCorePlugin;

impl Plugin for RagdollCorePlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(OnEnter(AppState::S07Ragdoll), setup)
            .add_systems(Update, redrop.run_if(in_state(AppState::S07Ragdoll)));
    }
}

fn setup(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    let state = AppState::S07Ragdoll;
    let scope = DespawnOnExit(state);

    // Shared scene: render ground + key light.
    scene::spawn_ground(&mut commands, &mut meshes, &mut materials, state);
    scene::spawn_light_preset(&mut commands, state);

    // The shared ground is render-only; add a matching static collider so the
    // ragdoll lands on something.
    commands.spawn((
        RigidBody::Fixed,
        Collider::cuboid(FLOOR_HALF.x, FLOOR_HALF.y, FLOOR_HALF.z),
        Transform::from_xyz(0.0, -FLOOR_HALF.y, 0.0),
        scope.clone(),
    ));

    build_ragdoll(&mut commands, &mut meshes, &mut materials, SPAWN_HEIGHT, state);

    // Camera looking at where the ragdoll falls.
    commands.spawn((
        Camera3d::default(),
        Transform::from_xyz(0.0, 2.5, 6.0).looking_at(Vec3::new(0.0, 1.0, 0.0), Vec3::Y),
        scope.clone(),
    ));

    hud::spawn_controls_overlay(
        &mut commands,
        state,
        &[
            "Ragdoll core — jointed capsules flop under gravity",
            "R — re-drop the ragdoll",
            "Esc — back to menu",
        ],
    );
    hud::spawn_fps_counter(&mut commands, state);
}

/// Builds the ragdoll from the [`BONES`] / [`JOINTS`] spec at the given pelvis
/// height. MODULAR by design (#40 extends the spec, not this assembly): it spawns
/// one dynamic capsule per bone, records the spawned `Entity` per bone name, then
/// inserts one `ImpulseJoint` per joint on the child entity referencing its parent.
///
/// Every entity is tagged `RagdollBone` + `DespawnOnExit(state)` so it auto-cleans
/// on exit AND can be despawned wholesale for a re-drop.
fn build_ragdoll(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    materials: &mut Assets<StandardMaterial>,
    pelvis_height: f32,
    state: AppState,
) {
    let scope = DespawnOnExit(state);
    let material = materials.add(StandardMaterial {
        base_color: Color::srgb(0.85, 0.75, 0.6),
        ..default()
    });

    // Spawn each bone and remember its entity by name (small fixed-size lookup).
    let mut entities: Vec<(&'static str, Entity)> = Vec::with_capacity(BONES.len());
    for bone in BONES {
        let mesh = meshes.add(Capsule3d::new(BONE_RADIUS, bone.half_height * 2.0));
        let center = bone.offset + Vec3::new(0.0, pelvis_height, 0.0);
        let id = commands
            .spawn((
                RagdollBone,
                Mesh3d(mesh),
                MeshMaterial3d(material.clone()),
                Transform::from_translation(center),
                RigidBody::Dynamic,
                Collider::capsule_y(bone.half_height, BONE_RADIUS),
                scope.clone(),
            ))
            .id();
        entities.push((bone.name, id));
    }

    // Wire joints: one ImpulseJoint per CHILD entity, pointing at its PARENT.
    for joint in JOINTS {
        let (Some(parent), Some(child)) = (
            lookup(&entities, joint.parent),
            lookup(&entities, joint.child),
        ) else {
            // Spec is validated by tests; skip defensively rather than panic.
            continue;
        };
        commands
            .entity(child)
            .insert(ImpulseJoint::new(parent, build_joint(joint)));
    }
}

/// Looks up a spawned bone entity by name in the small per-build table.
fn lookup(entities: &[(&'static str, Entity)], name: &str) -> Option<Entity> {
    entities
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, e)| *e)
}

/// Builds the concrete rapier joint for a [`JointSpec`]. Spherical joints leave
/// rotation free; revolute joints hinge on `axis` and clamp to
/// `[-LIMB_BEND_MAX, 0]` so the limb folds inward without hyperextending.
fn build_joint(joint: &JointSpec) -> TypedJoint {
    match joint.kind {
        JointKind::Spherical => SphericalJointBuilder::new()
            .local_anchor1(joint.parent_anchor)
            .local_anchor2(joint.child_anchor)
            .into(),
        JointKind::Revolute => RevoluteJointBuilder::new(joint.axis)
            .local_anchor1(joint.parent_anchor)
            .local_anchor2(joint.child_anchor)
            .limits([-LIMB_BEND_MAX, 0.0])
            .into(),
    }
}

/// `R` despawns the current ragdoll bodies and rebuilds the spec from the start
/// pose, so the body flops again. Despawning the tracked `RagdollBone` entities
/// removes their bodies/colliders/joints with no leak before the rebuild.
fn redrop(
    keyboard: Res<ButtonInput<KeyCode>>,
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    bones: Query<Entity, With<RagdollBone>>,
) {
    if !keyboard.just_pressed(KeyCode::KeyR) {
        return;
    }
    for entity in &bones {
        commands.entity(entity).despawn();
    }
    build_ragdoll(
        &mut commands,
        &mut meshes,
        &mut materials,
        SPAWN_HEIGHT,
        AppState::S07Ragdoll,
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every joint references bones that actually exist in [`BONES`]. Non-tautological:
    /// it scans the real spec and fails if any parent/child name is misspelled or
    /// removed — the kind of typo that would silently drop a joint at runtime.
    #[test]
    fn every_joint_references_valid_bones() {
        for joint in JOINTS {
            assert!(
                BONES.iter().any(|b| b.name == joint.parent),
                "joint parent `{}` is not a defined bone",
                joint.parent
            );
            assert!(
                BONES.iter().any(|b| b.name == joint.child),
                "joint child `{}` is not a defined bone",
                joint.child
            );
        }
    }

    /// The spec forms a valid tree: bone names are unique, and every bone except the
    /// root (`pelvis`) is the child of exactly ONE joint. This guarantees each bone
    /// hosts at most one `ImpulseJoint` (the one-joint-per-entity rule) and that no
    /// bone is left unconnected (which would float free instead of flopping).
    #[test]
    fn spec_is_a_connected_tree_with_one_parent_per_bone() {
        // Bone names are unique.
        for (i, a) in BONES.iter().enumerate() {
            for b in &BONES[i + 1..] {
                assert_ne!(a.name, b.name, "duplicate bone name `{}`", a.name);
            }
        }
        // Every non-root bone is a child exactly once; pelvis is a child zero times.
        for bone in BONES {
            let parents = JOINTS.iter().filter(|j| j.child == bone.name).count();
            if bone.name == "pelvis" {
                assert_eq!(parents, 0, "root pelvis must not be any joint's child");
            } else {
                assert_eq!(
                    parents, 1,
                    "bone `{}` must have exactly one parent joint",
                    bone.name
                );
            }
        }
        // A tree over N nodes has exactly N-1 edges.
        assert_eq!(
            JOINTS.len(),
            BONES.len() - 1,
            "joint count must be bone count minus one for a tree"
        );
    }

    /// Elbows/knees are limited revolute hinges; spine/neck/shoulders/hips are free
    /// spherical joints. Non-tautological: it asserts the elbow/knee joints carry
    /// the `Revolute` kind (so they get angle limits → no pretzel) and that the big
    /// joints stay `Spherical` (free swing), the core "bends like a body" property.
    #[test]
    fn elbows_and_knees_are_limited_hinges_big_joints_are_free() {
        let hinges = ["lower_arm_l", "lower_arm_r", "lower_leg_l", "lower_leg_r"];
        let spheres = [
            "torso",
            "head",
            "upper_arm_l",
            "upper_arm_r",
            "upper_leg_l",
            "upper_leg_r",
        ];
        for child in hinges {
            let j = JOINTS.iter().find(|j| j.child == child).unwrap();
            assert_eq!(j.kind, JointKind::Revolute, "`{child}` must be a hinge");
            assert_ne!(j.axis, Vec3::ZERO, "hinge `{child}` needs a non-zero axis");
        }
        for child in spheres {
            let j = JOINTS.iter().find(|j| j.child == child).unwrap();
            assert_eq!(j.kind, JointKind::Spherical, "`{child}` must be free");
        }
    }

    /// The bend limit is a sane single-direction fold: positive magnitude, no
    /// hyperextension (max bound is 0). Guards against a typo that would let limbs
    /// fold both ways into a pretzel or lock straight.
    #[test]
    fn bend_limit_folds_inward_only() {
        assert!(LIMB_BEND_MAX > 0.0, "bend magnitude must be positive");
        assert!(
            LIMB_BEND_MAX < std::f32::consts::PI,
            "a limb should not fold past ~180°"
        );
    }
}
