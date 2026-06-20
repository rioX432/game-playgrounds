//! # s02 — Physics grab & throw (bevy_rapier3d)
//!
//! **What it demonstrates:** A few dynamic cubes resting on a static floor.
//! Left-click casts a ray from the camera; the nearest hit dynamic body gets an
//! impulse along the ray direction — a "grab & throw / shove" interaction, the
//! REPO-style core verb.
//!
//! **Controls:** `Left Mouse` — raycast from screen center and throw the hit
//! body forward. `Esc` returns to the menu. (Camera is fixed for this sample;
//! the ray is cast along the camera's forward axis through screen center.)
//!
//! **Feel notes:** A single impulse reads as a satisfying "shove". Real grab
//! mechanics hold the body at a target point each frame (spring/joint) — that's
//! a follow-up. Tune `THROW_IMPULSE` vs cube mass: too high = comedic launch,
//! too low = unsatisfying nudge.
//!
//! **Bevy 0.18 / rapier 0.34 gotchas:**
//!   * Raycast goes through the `ReadRapierContext` SystemParam:
//!     `rapier.single()?.cast_ray(origin, dir, max_toi, solid)` returns
//!     `Option<(Entity, f32)>`. (Older tutorials use `Res<RapierContext>` —
//!     that resource no longer exists; the context lives on an entity.)
//!   * `cast_ray` in 0.34 takes NO `QueryFilter` arg (4 args: origin, dir,
//!     max_toi, solid).
//!   * Apply force with the `ExternalImpulse { impulse, torque_impulse }`
//!     component; insert/overwrite it on the hit entity.

use bevy::prelude::*;
use bevy_rapier3d::prelude::*;

use super::{AppState, SampleMeta};

pub const META: SampleMeta = SampleMeta {
    id: "02-physics-grab-throw",
    title: "Physics grab & throw (Rapier)",
    summary: "Raycast from the camera to shove the nearest dynamic body.",
    tags: &["physics", "rapier", "raycast", "impulse"],
};

/// Linear impulse magnitude applied to a hit body.
const THROW_IMPULSE: f32 = 12.0;
/// Max ray length (world units).
const RAY_MAX_TOI: f32 = 100.0;

#[derive(Component)]
struct ShooterCamera;

#[derive(Component)]
struct Throwable;

pub struct PhysicsGrabThrowPlugin;

impl Plugin for PhysicsGrabThrowPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(OnEnter(AppState::S02PhysicsGrabThrow), setup)
            .add_systems(
                Update,
                throw_on_click.run_if(in_state(AppState::S02PhysicsGrabThrow)),
            );
    }
}

fn setup(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
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
    let cube_mesh = meshes.add(Cuboid::new(1.0, 1.0, 1.0));
    for i in 0..5 {
        let x = -4.0 + i as f32 * 2.0;
        commands.spawn((
            Throwable,
            Mesh3d(cube_mesh.clone()),
            MeshMaterial3d(materials.add(StandardMaterial {
                base_color: Color::srgb(0.9, 0.5, 0.2),
                ..default()
            })),
            Transform::from_xyz(x, 0.5, -6.0),
            RigidBody::Dynamic,
            Collider::cuboid(0.5, 0.5, 0.5),
            // ExternalImpulse starts at zero; the throw system overwrites it.
            ExternalImpulse::default(),
            scope.clone(),
        ));
    }

    // Camera positioned to look at the cube row.
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

/// On left-click, cast a ray straight out of the camera and impulse the hit
/// body along the ray direction.
fn throw_on_click(
    buttons: Res<ButtonInput<MouseButton>>,
    rapier: ReadRapierContext,
    camera: Query<&GlobalTransform, With<ShooterCamera>>,
    mut throwables: Query<&mut ExternalImpulse, With<Throwable>>,
) {
    if !buttons.just_pressed(MouseButton::Left) {
        return;
    }
    let Ok(cam) = camera.single() else {
        return;
    };
    let Ok(ctx) = rapier.single() else {
        return;
    };

    let origin = cam.translation();
    // Camera looks down -Z in its local frame; forward() returns that in world.
    let dir = cam.forward().as_vec3();

    // 4-arg cast_ray (origin, dir, max_toi, solid). solid=true reports a hit
    // even if the origin starts inside a shape.
    if let Some((entity, _toi)) = ctx.cast_ray(origin, dir, RAY_MAX_TOI, true) {
        if let Ok(mut impulse) = throwables.get_mut(entity) {
            impulse.impulse = dir * THROW_IMPULSE;
        }
    }
}
