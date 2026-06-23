//! # s02 — Physics grab & throw (bevy_rapier3d)
//!
//! **What it demonstrates:** A few dynamic cubes resting on a static floor with
//! the full **grab → hold → throw** verb, matching the Three.js / Babylon.js `02`
//! peers (it previously implemented only a one-shot "shove"). Left-click casts a
//! ray from the camera; the first click **grabs** the hit body and holds it
//! floating at a fixed distance in front of the camera (velocity-driven, like a
//! soft spring); the second click **throws** it along the camera forward with an
//! impulse and releases it.
//!
//! **Controls:** `Left Mouse` — click a body to grab it (raycast from screen
//! center), click again to throw it. `Esc` returns to the menu. (Camera is fixed
//! for this sample, as in the Three.js peer; the ray + hold target are along the
//! camera's forward axis.)
//!
//! **Feel notes:** The velocity-spring hold is "rubbery" — the body lags toward
//! the target rather than snapping, which reads as physical but can feel loose if
//! `HOLD_STIFFNESS` is low. Throwing is satisfying once `THROW_IMPULSE` is tuned
//! against cube mass: too high = comedic launch, too low = an unsatisfying nudge.
//! Because the camera is fixed, the hold point is a fixed spot in front of it
//! (no aiming-while-holding) — the honest cost of keeping this sample camera-free
//! to match the Three.js reference; the Babylon peer adds an orbit camera.
//!
//! **Bevy 0.18 / rapier 0.34 gotchas:**
//!   * Raycast goes through the `ReadRapierContext` SystemParam:
//!     `rapier.single()?.cast_ray(origin, dir, max_toi, solid, filter)` returns
//!     `Option<(Entity, f32)>`. (Older tutorials use `Res<RapierContext>` —
//!     that resource no longer exists; the context lives on an entity.)
//!   * Hold the body by writing its `Velocity` component each frame (kinematic-
//!     by-velocity), the rapier equivalent of Three's `setLinvel`. The body stays
//!     `RigidBody::Dynamic` so the throw impulse and gravity work normally.
//!   * Throw with the `ExternalImpulse { impulse, .. }` component; rapier applies
//!     it once on the next step and resets it to zero automatically.
//!   * The grab state is a `Resource` — `DespawnOnExit` despawns entities but does
//!     NOT reset resources, so `setup` re-inserts a fresh `GrabState` on every
//!     `OnEnter` (a stale held `Entity` would otherwise survive a sample switch).

use bevy::prelude::*;
use bevy_rapier3d::prelude::*;

use super::{AppState, SampleMeta};

pub const META: SampleMeta = SampleMeta {
    id: "02-physics-grab-throw",
    title: "Physics grab & throw (Rapier)",
    summary: "Raycast to grab a dynamic body, hold it in front of the camera, click to throw.",
    tags: &["physics", "rapier", "raycast", "interaction"],
};

/// Linear impulse magnitude applied to a thrown body.
const THROW_IMPULSE: f32 = 12.0;
/// How far in front of the camera a grabbed body is held (world units).
const HOLD_DISTANCE: f32 = 4.0;
/// Velocity gain pulling a held body toward the hold target (1/second).
const HOLD_STIFFNESS: f32 = 14.0;
/// Max ray length (world units).
const RAY_MAX_TOI: f32 = 100.0;

#[derive(Component)]
struct ShooterCamera;

#[derive(Component)]
struct Throwable;

/// Which body is currently grabbed (if any). A `Resource`, so it must be reset on
/// `OnEnter` — see the module header's cleanup note.
#[derive(Resource, Default)]
struct GrabState {
    held: Option<Entity>,
}

pub struct PhysicsGrabThrowPlugin;

impl Plugin for PhysicsGrabThrowPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<GrabState>()
            .add_systems(OnEnter(AppState::S02PhysicsGrabThrow), setup)
            .add_systems(
                Update,
                // Grab/throw toggles the state first; the hold then drives the
                // held body the same frame (and skips on the frame it's released).
                (grab_or_throw, hold_grabbed)
                    .chain()
                    .run_if(in_state(AppState::S02PhysicsGrabThrow)),
            );
    }
}

fn setup(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut grab: ResMut<GrabState>,
) {
    // Reset the grab state: a held `Entity` from a previous visit is now stale
    // (its body was despawned by `DespawnOnExit`).
    *grab = GrabState::default();

    let scope = DespawnOnExit(AppState::S02PhysicsGrabThrow);

    // Static floor: a fixed body with a cuboid collider (half-extents).
    commands.spawn((
        Mesh3d(meshes.add(Plane3d::default().mesh().size(40.0, 40.0))),
        MeshMaterial3d(materials.add(StandardMaterial {
            base_color: Color::srgb(0.35, 0.35, 0.4),
            ..default()
        })),
        Transform::IDENTITY,
        RigidBody::Fixed,
        Collider::cuboid(20.0, 0.05, 20.0),
        scope.clone(),
    ));

    // A small grid of dynamic cubes.
    // Eight cubes in a 4x2 grid (matches the TS peers' BOX_COUNT = 8).
    let cube_mesh = meshes.add(Cuboid::new(1.0, 1.0, 1.0));
    for i in 0..8 {
        let col = (i % 4) as f32;
        let row = (i / 4) as f32;
        let x = col * 1.5 - 2.25;
        let z = -6.0 + row * 1.5;
        commands.spawn((
            Throwable,
            Mesh3d(cube_mesh.clone()),
            MeshMaterial3d(materials.add(StandardMaterial {
                base_color: Color::srgb(0.9, 0.5, 0.2),
                ..default()
            })),
            Transform::from_xyz(x, 0.5, z),
            RigidBody::Dynamic,
            Collider::cuboid(0.5, 0.5, 0.5),
            // `Velocity` lets the hold drive the body kinematically each frame;
            // `ExternalImpulse` carries the throw (rapier resets it after a step).
            Velocity::zero(),
            ExternalImpulse::default(),
            scope.clone(),
        ));
    }

    // Camera positioned to look at the cube row (fixed — matches the TS peer).
    commands.spawn((
        ShooterCamera,
        Camera3d::default(),
        Transform::from_xyz(0.0, 3.0, 4.0).looking_at(Vec3::new(0.0, 0.5, -6.0), Vec3::Y),
        scope.clone(),
    ));

    commands.spawn((
        DirectionalLight {
            illuminance: 10_000.0,
            shadows_enabled: true,
            ..default()
        },
        Transform::from_xyz(4.0, 8.0, 4.0).looking_at(Vec3::ZERO, Vec3::Y),
        scope,
    ));
}

/// On left-click: if nothing is held, raycast from the camera and grab the hit
/// throwable; if a body is held, throw it along the camera forward and release.
fn grab_or_throw(
    buttons: Res<ButtonInput<MouseButton>>,
    rapier: ReadRapierContext,
    camera: Query<&GlobalTransform, With<ShooterCamera>>,
    mut grab: ResMut<GrabState>,
    mut throwables: Query<&mut ExternalImpulse, With<Throwable>>,
) {
    if !buttons.just_pressed(MouseButton::Left) {
        return;
    }
    let Ok(cam) = camera.single() else {
        return;
    };
    // Camera looks down -Z in its local frame; forward() returns that in world.
    let dir = cam.forward().as_vec3();

    // Holding a body -> throw it along the camera forward and release.
    if let Some(entity) = grab.held.take() {
        if let Ok(mut impulse) = throwables.get_mut(entity) {
            impulse.impulse = throw_impulse(dir, THROW_IMPULSE);
        }
        return;
    }

    // Nothing held -> raycast from screen center and grab the nearest throwable.
    let Ok(ctx) = rapier.single() else {
        return;
    };
    let origin = cam.translation();
    if let Some((entity, _toi)) = ctx.cast_ray(origin, dir, RAY_MAX_TOI, true, QueryFilter::default())
    {
        if throwables.get(entity).is_ok() {
            grab.held = Some(entity);
        }
    }
}

/// While a body is held, drive its velocity toward a point [`HOLD_DISTANCE`] in
/// front of the camera (a soft velocity spring), zeroing spin. Mirrors the
/// Three.js peer's per-frame `setLinvel` hold.
fn hold_grabbed(
    grab: Res<GrabState>,
    camera: Query<&GlobalTransform, With<ShooterCamera>>,
    mut bodies: Query<(&Transform, &mut Velocity), With<Throwable>>,
) {
    let Some(entity) = grab.held else {
        return;
    };
    let Ok(cam) = camera.single() else {
        return;
    };
    let Ok((transform, mut velocity)) = bodies.get_mut(entity) else {
        return;
    };
    let target = cam.translation() + cam.forward().as_vec3() * HOLD_DISTANCE;
    velocity.linear = hold_velocity(target, transform.translation, HOLD_STIFFNESS);
    velocity.angular = Vec3::ZERO;
}

/// Pure helper: the velocity that pulls a body at `pos` toward `target` with a
/// proportional `stiffness` gain. Extracted so the hold law is testable headless.
fn hold_velocity(target: Vec3, pos: Vec3, stiffness: f32) -> Vec3 {
    (target - pos) * stiffness
}

/// Pure helper: the impulse imparted to a thrown body — `magnitude` along the
/// (already unit-length camera-forward) `dir`. Extracted for a headless test.
fn throw_impulse(dir: Vec3, magnitude: f32) -> Vec3 {
    dir * magnitude
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The hold velocity points from the body toward the target and scales with
    /// the gap, so a held body is pulled to the hold point.
    #[test]
    fn hold_velocity_pulls_toward_target() {
        let target = Vec3::new(0.0, 2.0, 0.0);
        let pos = Vec3::new(0.0, 0.0, -6.0);
        let v = hold_velocity(target, pos, HOLD_STIFFNESS);
        // Direction matches (target - pos); magnitude is gap * stiffness.
        assert!(v.y > 0.0, "should pull up toward the target, got {v:?}");
        assert!(v.z > 0.0, "should pull toward +Z (target is in front), got {v:?}");
        let expected = (target - pos) * HOLD_STIFFNESS;
        assert!((v - expected).length() < 1e-5);
    }

    /// At the target the hold velocity is zero (settled, no jitter).
    #[test]
    fn hold_velocity_is_zero_at_target() {
        let p = Vec3::new(1.0, 2.0, 3.0);
        assert_eq!(hold_velocity(p, p, HOLD_STIFFNESS), Vec3::ZERO);
    }

    /// The throw impulse is `magnitude` along the camera forward.
    #[test]
    fn throw_impulse_is_forward_scaled() {
        let dir = Vec3::new(0.0, 0.0, -1.0);
        let imp = throw_impulse(dir, THROW_IMPULSE);
        assert_eq!(imp, Vec3::new(0.0, 0.0, -THROW_IMPULSE));
    }
}
