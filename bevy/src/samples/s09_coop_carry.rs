//! # s09 — Co-op carry physics (joint-coupled two-carrier plank)
//!
//! **What it demonstrates:** A long, heavy DYNAMIC plank carried by TWO dynamic
//! carrier bodies, each coupled to the plank by a rapier spherical (ball) joint.
//! A spherical joint pins a point but leaves rotation free, so the plank can
//! TILT and SWAY about the two carry points — exactly the awkward "two people
//! carrying a couch" feel. You drive carrier A directly (WASD); carrier B
//! follows A at a fixed side offset via a soft P-controller, so it LAGS A's
//! motion. When the two carry points are out of sync (B catching up), the plank
//! swings and rolls — the "co-op" angle, read on a single machine. `Space`
//! detaches / re-attaches BOTH carry joints (drop & pick up the plank).
//!
//! **Controls:** `W/A/S/D` — drive carrier A on the ground plane (world axes,
//! W = -Z). `Space` — toggle attach/detach of both carry joints (drop the plank,
//! press again to pick it back up). `Esc` — back to the menu.
//!
//! **Feel notes:** The honest feel here is *the awkwardness of coordinated
//! carry*. Because B lags A (the P-controller is intentionally soft), any quick
//! change of direction makes the plank lurch and tilt before B catches up — it
//! genuinely feels like wrangling a long object with a slow partner, which is the
//! point. Honest bad parts: (1) carrier B is an AI follower with a single P-gain,
//! so it has no anticipation — it always trails and never "reads" your intent, so
//! coordinated turns feel one-sided rather than a true two-player negotiation.
//! (2) The carriers are rotation-locked dynamic bodies driven directly by
//! velocity, so they can shove the plank with unrealistic authority (no arm
//! compliance) — the plank's sway comes only from the spherical joints, not from
//! the carriers giving. (3) With both joints spherical the plank can spin about
//! the carry axis more freely than a real two-handed grip would allow; a real
//! carry constrains roll more. (4) Detach drops the plank straight down with no
//! "letting go" animation, so pick-up/drop reads as a teleport of constraints
//! rather than hands releasing.
//!
//! **Bevy 0.18 / rapier 0.34 gotchas:**
//!   * The rapier plugin is GLOBAL (added once in `main.rs`); this sample only
//!     spawns physics entities. Cleanup is AUTOMATIC: every body / collider /
//!     joint entity carries `DespawnOnExit(AppState::S09CoopCarry)`, so leaving
//!     the sample despawns them and rapier removes the underlying bodies/joints —
//!     NO manual world teardown.
//!   * Joints use the 0.34 builder API:
//!     `SphericalJointBuilder::new().local_anchor1(a1).local_anchor2(a2)`, wrapped
//!     in `ImpulseJoint::new(other_entity, builder)` and INSERTED on the carrier.
//!     `local_anchor1` is in the OTHER body's (the plank's) local space,
//!     `local_anchor2` in THIS entity's (the carrier's) local space. The builder
//!     impls `Into<TypedJoint>`, so it passes straight to `ImpulseJoint::new`.
//!   * An entity can hold only ONE `ImpulseJoint`. The plank needs to be coupled
//!     to BOTH carriers, so each JOINT lives on a CARRIER (one each), both
//!     referencing the single plank entity as their `other_entity`. The plank
//!     itself holds no joint — this keeps it to one constraint per entity.
//!   * Carriers are `RigidBody::Dynamic` + `LockedAxes::ROTATION_LOCKED` so they
//!     stay upright, and are moved by writing `Velocity.linear` (the 0.34 field
//!     is `linear`/`angular`, NOT `linvel`/`angvel` — rapier reads it each step).
//!     bevy_rapier writes each dynamic body's pose back into its
//!     entity `Transform` every frame — READ `Transform` directly, never copy
//!     body→mesh by hand.
//!   * `Time` delta is `time.delta_secs()` (f32); `Query::single()` returns
//!     `Result` — handle with `let Ok(..) = .. else { return; };`.
//!
//! **Shared input:** carrier A reads the global [`MoveIntent`] resource owned by
//! `engine::input::FoundationInputPlugin`. The detach toggle reads
//! `ButtonInput<KeyCode>` directly (a one-off edge, not a shared intent).
//!
//! **Shared HUD/scene:** ground + light come from `engine::scene`; the controls
//! overlay + FPS counter from `engine::hud`. Both are `DespawnOnExit`-scoped
//! internally; only the carriers, plank, camera, and attach-state HUD line are
//! spawned inline here.

use bevy::prelude::*;
use bevy_rapier3d::prelude::*;

use crate::engine::hud;
use crate::engine::input::MoveIntent;
use crate::engine::scene;

use super::{AppState, SampleMeta};

pub const META: SampleMeta = SampleMeta {
    id: "09-coop-carry",
    title: "Co-op carry physics (joint-coupled plank)",
    summary: "Carry a long dynamic plank via two joints — drive A, B lags, so it sways.",
    tags: &["physics", "rapier", "joint", "co-op"],
};

/// Carrier A drive speed (target linear velocity magnitude, world units/sec).
const CARRIER_SPEED: f32 = 4.0;
/// Soft P-controller gain for carrier B following A's offset target (1/sec). Low
/// on purpose: B lags A, which is what makes the plank sway out of sync.
const FOLLOW_GAIN: f32 = 3.0;
/// Cap on carrier B's follow velocity so a large gap can't fling it (world
/// units/sec). Slightly above A's speed so B can still close the gap.
const FOLLOW_MAX_SPEED: f32 = 5.0;

/// Half the distance between the two carry points (each carrier sits under one
/// plank end; this is the plank's half-length on X).
const CARRY_HALF_SPAN: f32 = 2.0;
/// Carrier capsule radius and half-height.
const CARRIER_RADIUS: f32 = 0.4;
const CARRIER_HALF_HEIGHT: f32 = 0.5;
/// Y the carriers (and thus the plank) ride at.
const CARRY_Y: f32 = 1.2;

/// Plank half-extents (a long thin box; `CARRY_HALF_SPAN` is its half-length X).
const PLANK_HALF: Vec3 = Vec3::new(CARRY_HALF_SPAN, 0.12, 0.4);
/// Plank density — heavier than the carriers so it reads as a real load.
const PLANK_DENSITY: f32 = 2.0;

/// Carrier A start position (B starts one full span to its +X).
const CARRIER_A_START: Vec3 = Vec3::new(-CARRY_HALF_SPAN, CARRY_Y, 0.0);

/// Static floor half-extents (matches the shared render ground footprint).
const FLOOR_HALF: Vec3 = Vec3::new(20.0, 0.05, 20.0);

/// Marks the player-driven carrier A.
#[derive(Component)]
struct CarrierA;

/// Marks the AI follower carrier B.
#[derive(Component)]
struct CarrierB;

/// Marks the dynamic plank being carried.
#[derive(Component)]
struct Plank;

/// Marker for the HUD line showing the current attach state.
#[derive(Component)]
struct AttachHudText;

/// Whether the carry joints are currently attached. A **resource** (not an
/// entity), so it is NOT cleared by `DespawnOnExit` — [`setup`] re-inserts a
/// fresh one on every `OnEnter` to guarantee a clean (attached) start.
#[derive(Resource, Debug, Clone, Copy)]
struct CarryState {
    /// `true` while both carry joints exist (plank is being carried).
    attached: bool,
}

impl Default for CarryState {
    fn default() -> Self {
        Self { attached: true }
    }
}

pub struct CoopCarryPlugin;

impl Plugin for CoopCarryPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(OnEnter(AppState::S09CoopCarry), setup).add_systems(
            Update,
            (drive_carrier_a, follow_carrier_b, toggle_attach, update_hud)
                .chain()
                .run_if(in_state(AppState::S09CoopCarry)),
        );
    }
}

/// Spawns the carry rig (two carriers + plank + two carry joints), the camera,
/// the shared scene/HUD, and (re-)inserts a fresh [`CarryState`] so a re-entered
/// sample starts attached. Every spawned entity is `DespawnOnExit`-scoped; the
/// resource reset here is the cleanup for the non-entity attach state.
fn setup(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    let state = AppState::S09CoopCarry;
    let scope = DespawnOnExit(state);

    // Re-init attach state on every enter — DespawnOnExit does NOT clear
    // resources, so without this a re-entered sample could inherit a "detached"
    // flag from a prior run.
    commands.insert_resource(CarryState::default());

    // Shared scene: ground (render) + key light.
    scene::spawn_ground(&mut commands, &mut meshes, &mut materials, state);
    scene::spawn_light_preset(&mut commands, state);
    // The shared ground is render-only; add a matching static collider so the
    // dropped plank has something to land on.
    commands.spawn((
        RigidBody::Fixed,
        Collider::cuboid(FLOOR_HALF.x, FLOOR_HALF.y, FLOOR_HALF.z),
        Transform::from_xyz(0.0, -FLOOR_HALF.y, 0.0),
        scope.clone(),
    ));

    spawn_carry_rig(&mut commands, &mut meshes, &mut materials, state);

    // Chase camera looking at the carry rig.
    commands.spawn((
        Camera3d::default(),
        Transform::from_xyz(0.0, 7.0, 9.0).looking_at(Vec3::new(0.0, CARRY_Y, 0.0), Vec3::Y),
        scope.clone(),
    ));

    // Attach-state HUD line, updated every frame.
    commands.spawn((
        AttachHudText,
        scope,
        Text::new(""),
        TextFont {
            font_size: 20.0,
            ..default()
        },
        TextColor(Color::srgb(0.9, 0.9, 0.95)),
        Node {
            position_type: PositionType::Absolute,
            top: Val::Px(8.0),
            left: Val::Px(8.0),
            ..default()
        },
    ));

    hud::spawn_controls_overlay(
        &mut commands,
        state,
        &[
            "WASD — drive carrier A (B follows, lagging)",
            "Space — drop / pick up the plank",
            "Esc — back to menu",
        ],
    );
    hud::spawn_fps_counter(&mut commands, state);
}

/// Spawns the two carriers and the dynamic plank, then couples each carrier to
/// the plank with a spherical (ball) carry joint.
///
/// Joint hosting: an entity may hold only ONE `ImpulseJoint`. The plank needs two
/// couplings, so each carry JOINT is hosted on its CARRIER (one joint per
/// carrier), both pointing at the single plank entity. The plank holds no joint.
fn spawn_carry_rig(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    materials: &mut Assets<StandardMaterial>,
    state: AppState,
) {
    let scope = DespawnOnExit(state);

    let a_pos = CARRIER_A_START;
    let b_pos = carrier_b_target(a_pos);
    let plank_center = (a_pos + b_pos) * 0.5;

    // The plank: a long dynamic box spanning between the two carriers. Holds no
    // joint itself; the carriers reference it.
    let plank = commands
        .spawn((
            Plank,
            Mesh3d(meshes.add(Cuboid::new(
                PLANK_HALF.x * 2.0,
                PLANK_HALF.y * 2.0,
                PLANK_HALF.z * 2.0,
            ))),
            MeshMaterial3d(materials.add(StandardMaterial {
                base_color: Color::srgb(0.6, 0.4, 0.25),
                ..default()
            })),
            Transform::from_translation(plank_center),
            RigidBody::Dynamic,
            Collider::cuboid(PLANK_HALF.x, PLANK_HALF.y, PLANK_HALF.z),
            ColliderMassProperties::Density(PLANK_DENSITY),
            scope.clone(),
        ))
        .id();

    let carrier_mesh = meshes.add(Capsule3d::new(CARRIER_RADIUS, CARRIER_HALF_HEIGHT * 2.0));

    // Carrier A (player-driven). Hosts the spherical joint to the plank's -X end.
    commands.spawn((
        CarrierA,
        Mesh3d(carrier_mesh.clone()),
        MeshMaterial3d(materials.add(StandardMaterial {
            base_color: Color::srgb(0.2, 0.5, 0.9),
            ..default()
        })),
        Transform::from_translation(a_pos),
        RigidBody::Dynamic,
        Collider::capsule_y(CARRIER_HALF_HEIGHT, CARRIER_RADIUS),
        LockedAxes::ROTATION_LOCKED,
        Velocity::zero(),
        ImpulseJoint::new(plank, carry_joint(-CARRY_HALF_SPAN)),
        scope.clone(),
    ));

    // Carrier B (AI follower). Hosts the spherical joint to the plank's +X end.
    commands.spawn((
        CarrierB,
        Mesh3d(carrier_mesh),
        MeshMaterial3d(materials.add(StandardMaterial {
            base_color: Color::srgb(0.9, 0.5, 0.2),
            ..default()
        })),
        Transform::from_translation(b_pos),
        RigidBody::Dynamic,
        Collider::capsule_y(CARRIER_HALF_HEIGHT, CARRIER_RADIUS),
        LockedAxes::ROTATION_LOCKED,
        Velocity::zero(),
        ImpulseJoint::new(plank, carry_joint(CARRY_HALF_SPAN)),
        scope.clone(),
    ));
}

/// Builds a spherical carry joint pinning a carrier (anchor at its origin) to the
/// plank at the given X end (in the plank's local space). Spherical = rotation
/// free, so the plank tilts/sways about the carry point.
///
/// `local_anchor1` is in the OTHER body's (the plank's) frame; `local_anchor2` is
/// in THIS entity's (the carrier's) frame — the carrier grips at its own origin.
fn carry_joint(plank_x_end: f32) -> SphericalJointBuilder {
    SphericalJointBuilder::new()
        .local_anchor1(Vec3::new(plank_x_end, 0.0, 0.0))
        .local_anchor2(Vec3::ZERO)
}

/// Drives carrier A by writing its target linear velocity from the shared
/// [`MoveIntent`]. Y velocity is preserved (gravity/joint forces own it); only
/// the XZ plane is steered.
fn drive_carrier_a(intent: Res<MoveIntent>, mut q: Query<&mut Velocity, With<CarrierA>>) {
    let Ok(mut vel) = q.single_mut() else {
        return;
    };
    let target = intent.dir * CARRIER_SPEED;
    vel.linear.x = target.x;
    vel.linear.z = target.z;
}

/// Carrier B follows A at the side offset via a soft P-controller: it reads A's
/// position, computes its own target ([`carrier_b_target`]), and sets its XZ
/// velocity toward that target ([`follow_velocity`]). The low gain makes B LAG,
/// which is what makes the jointed plank sway out of sync.
fn follow_carrier_b(
    a_q: Query<&Transform, With<CarrierA>>,
    mut b_q: Query<(&Transform, &mut Velocity), With<CarrierB>>,
) {
    let Ok(a_tf) = a_q.single() else {
        return;
    };
    let Ok((b_tf, mut b_vel)) = b_q.single_mut() else {
        return;
    };
    let target = carrier_b_target(a_tf.translation);
    let v = follow_velocity(b_tf.translation, target, FOLLOW_GAIN, FOLLOW_MAX_SPEED);
    b_vel.linear.x = v.x;
    b_vel.linear.z = v.z;
}

/// `Space` detaches / re-attaches BOTH carry joints. Detach removes the
/// `ImpulseJoint` from each carrier (rapier drops the constraint → the plank
/// falls); re-attach re-inserts fresh joints at the carriers' current poses.
/// Removing the component removes the joint with NO leak; entity despawn on exit
/// handles the rest.
fn toggle_attach(
    keyboard: Res<ButtonInput<KeyCode>>,
    mut state: ResMut<CarryState>,
    mut commands: Commands,
    plank_q: Query<Entity, With<Plank>>,
    carrier_a_q: Query<Entity, With<CarrierA>>,
    carrier_b_q: Query<Entity, With<CarrierB>>,
) {
    if !keyboard.just_pressed(KeyCode::Space) {
        return;
    }
    let (Ok(plank), Ok(carrier_a), Ok(carrier_b)) =
        (plank_q.single(), carrier_a_q.single(), carrier_b_q.single())
    else {
        return;
    };

    if state.attached {
        // Detach: drop both carry joints. Removing ImpulseJoint releases the
        // rapier constraint cleanly (no leak).
        commands.entity(carrier_a).remove::<ImpulseJoint>();
        commands.entity(carrier_b).remove::<ImpulseJoint>();
        state.attached = false;
    } else {
        // Re-attach: re-pin each carrier to its plank end at the current poses.
        commands
            .entity(carrier_a)
            .insert(ImpulseJoint::new(plank, carry_joint(-CARRY_HALF_SPAN)));
        commands
            .entity(carrier_b)
            .insert(ImpulseJoint::new(plank, carry_joint(CARRY_HALF_SPAN)));
        state.attached = true;
    }
}

/// Writes the attach state to the HUD line.
fn update_hud(state: Res<CarryState>, mut hud_q: Query<&mut Text, With<AttachHudText>>) {
    let Ok(mut text) = hud_q.single_mut() else {
        return;
    };
    **text = attach_label(state.attached).to_string();
}

// ---------------------------------------------------------------------------
// Pure logic (headless-testable, no ECS / window / rapier stepping)
// ---------------------------------------------------------------------------

/// Carrier B's target position: carrier A's position shifted by the full carry
/// span along +X (B carries the plank's far end). Pure so headless tests can
/// assert B tracks A at the offset without a window or rapier.
fn carrier_b_target(carrier_a_pos: Vec3) -> Vec3 {
    carrier_a_pos + Vec3::new(CARRY_HALF_SPAN * 2.0, 0.0, 0.0)
}

/// Soft P-controller follow step: velocity = clamp(gain * (target - current)) on
/// the XZ plane (Y left to gravity/joints). The magnitude is capped at
/// `max_speed` so a large gap can't fling the follower — the cap bounds the lag
/// instead of letting it overshoot. Pure so tests can assert it moves TOWARD the
/// target without overshoot blowup.
fn follow_velocity(current: Vec3, target: Vec3, gain: f32, max_speed: f32) -> Vec3 {
    let mut delta = target - current;
    delta.y = 0.0;
    let v = delta * gain;
    let speed = v.length();
    if speed > max_speed {
        v * (max_speed / speed)
    } else {
        v
    }
}

/// Pure HUD label for the attach state.
fn attach_label(attached: bool) -> &'static str {
    if attached {
        "CARRYING — Space to drop"
    } else {
        "DROPPED — Space to pick up"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Carrier B's target tracks A at a fixed +X offset of one full span (2 *
    /// half-span). Non-tautological: checks the offset magnitude, axis, and that
    /// it translates rigidly with A (Z/Y carry over unchanged).
    #[test]
    fn carrier_b_target_tracks_a_at_offset() {
        let a = Vec3::new(1.0, CARRY_Y, -3.0);
        let b = carrier_b_target(a);
        assert!(
            (b.x - (a.x + CARRY_HALF_SPAN * 2.0)).abs() < 1e-5,
            "B sits one span +X of A"
        );
        assert_eq!(b.z, a.z, "offset is on +X only — Z tracks A");
        assert_eq!(b.y, a.y, "offset is on +X only — Y tracks A");

        // Moving A by an arbitrary XZ delta moves B by the SAME delta (rigid offset).
        let a2 = a + Vec3::new(2.0, 0.0, 5.0);
        let b2 = carrier_b_target(a2);
        assert!(
            (b2 - b - Vec3::new(2.0, 0.0, 5.0)).length() < 1e-5,
            "B follows A rigidly"
        );
    }

    /// The follow step always points TOWARD the target on the XZ plane and never
    /// along Y. Non-tautological: checks the velocity reduces the gap (dot with the
    /// gap direction > 0) and that a zero gap yields zero velocity (no rest jitter).
    #[test]
    fn follow_velocity_points_toward_target_on_xz() {
        let current = Vec3::new(0.0, CARRY_Y, 0.0);
        let target = Vec3::new(3.0, CARRY_Y + 1.0, 4.0); // Y differs — must be ignored
        let v = follow_velocity(current, target, FOLLOW_GAIN, FOLLOW_MAX_SPEED);

        assert_eq!(v.y, 0.0, "follow never drives Y (gravity/joints own it)");
        let gap_xz = Vec3::new(target.x - current.x, 0.0, target.z - current.z);
        assert!(v.dot(gap_xz) > 0.0, "velocity must point toward the target");

        // At rest on the target, velocity is zero (no chatter).
        let at_target = follow_velocity(target, target, FOLLOW_GAIN, FOLLOW_MAX_SPEED);
        assert_eq!(
            Vec3::new(at_target.x, 0.0, at_target.z),
            Vec3::ZERO,
            "no follow velocity once on target"
        );
    }

    /// The velocity cap bounds the follow speed: a huge gap produces a velocity of
    /// exactly `max_speed` (clamped), not `gain * gap` — this is what prevents the
    /// follower flinging / overshoot blowup when far behind. A small gap stays
    /// UNclamped (proportional). Non-tautological: exercises both sides of the cap.
    #[test]
    fn follow_velocity_caps_speed_to_prevent_blowup() {
        let current = Vec3::ZERO;

        // Huge gap → clamped to max_speed.
        let far = Vec3::new(100.0, 0.0, 0.0);
        let v_far = follow_velocity(current, far, FOLLOW_GAIN, FOLLOW_MAX_SPEED);
        assert!(
            (v_far.length() - FOLLOW_MAX_SPEED).abs() < 1e-4,
            "far gap clamps to max_speed, got {}",
            v_far.length()
        );

        // Small gap (gain * gap < max_speed) → proportional, unclamped.
        let near = Vec3::new(0.1, 0.0, 0.0);
        let v_near = follow_velocity(current, near, FOLLOW_GAIN, FOLLOW_MAX_SPEED);
        assert!(
            (v_near.length() - 0.1 * FOLLOW_GAIN).abs() < 1e-5,
            "small gap is proportional (P-controller), got {}",
            v_near.length()
        );
        assert!(
            v_near.length() < FOLLOW_MAX_SPEED,
            "small gap stays under the cap"
        );
    }

    /// The attach label reflects the carry state both ways.
    #[test]
    fn attach_label_reflects_state() {
        assert_eq!(attach_label(true), "CARRYING — Space to drop");
        assert_eq!(attach_label(false), "DROPPED — Space to pick up");
    }
}
