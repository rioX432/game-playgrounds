//! # s01 — Third-person character controller
//!
//! **What it demonstrates:** A capsule "player" you drive with WASD, plus a
//! follow camera trailing it over a ground plane. Movement is Transform-based
//! (no physics engine) — the simplest faithful version of the mechanic, good
//! for judging raw control feel before adding collision.
//!
//! **Controls:** `W/A/S/D` move (camera-relative on the XZ plane). `Esc`
//! returns to the menu.
//!
//! **Feel notes:** Instant accel/decel = very responsive but "slidey-free" and
//! arcade-stiff; real games add accel ramps + a small camera lag. The follow
//! camera here is a hard offset (no smoothing), so fast direction changes look
//! snappy but slightly robotic. Document both when iterating.
//!
//! **Bevy 0.18 gotchas:**
//!   * Spawn meshes with `Mesh3d(handle)` + `MeshMaterial3d(handle)` — the old
//!     `PbrBundle` is gone.
//!   * Scoped cleanup uses `DespawnOnExit(state)` (0.18), NOT `StateScoped`.
//!   * `Time` delta is `time.delta_secs()` (f32), not the old `delta_seconds()`.

use bevy::prelude::*;

use super::{AppState, SampleMeta};

pub const META: SampleMeta = SampleMeta {
    id: "01-character-controller",
    title: "Third-person character controller",
    summary: "WASD-drive a capsule with a follow camera over a ground plane.",
    tags: &["movement", "camera", "transform"],
};

/// Player movement speed in world units / second.
const MOVE_SPEED: f32 = 6.0;
/// Camera offset behind/above the player (world units).
const CAMERA_OFFSET: Vec3 = Vec3::new(0.0, 6.0, 10.0);

#[derive(Component)]
struct Player;

#[derive(Component)]
struct FollowCamera;

pub struct CharacterControllerPlugin;

impl Plugin for CharacterControllerPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(OnEnter(AppState::S01CharacterController), setup)
            .add_systems(
                Update,
                (move_player, follow_camera)
                    .chain()
                    .run_if(in_state(AppState::S01CharacterController)),
            );
    }
}

fn setup(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    let scope = DespawnOnExit(AppState::S01CharacterController);

    // Ground plane.
    commands.spawn((
        Mesh3d(meshes.add(Plane3d::default().mesh().size(40.0, 40.0))),
        MeshMaterial3d(materials.add(StandardMaterial {
            base_color: Color::srgb(0.3, 0.5, 0.3),
            ..default()
        })),
        Transform::IDENTITY,
        scope.clone(),
    ));

    // Player capsule.
    commands.spawn((
        Player,
        Mesh3d(meshes.add(Capsule3d::new(0.5, 1.0))),
        MeshMaterial3d(materials.add(StandardMaterial {
            base_color: Color::srgb(0.2, 0.5, 0.9),
            ..default()
        })),
        Transform::from_xyz(0.0, 1.0, 0.0),
        scope.clone(),
    ));

    // Follow camera, starting at the player's offset.
    commands.spawn((
        FollowCamera,
        Camera3d::default(),
        Transform::from_translation(CAMERA_OFFSET).looking_at(Vec3::ZERO, Vec3::Y),
        scope.clone(),
    ));

    // Light.
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

/// Moves the player on the XZ plane from WASD. Camera-relative would need the
/// camera yaw; for this minimal version we use world axes (W = -Z).
fn move_player(
    time: Res<Time>,
    keyboard: Res<ButtonInput<KeyCode>>,
    mut query: Query<&mut Transform, With<Player>>,
) {
    let Ok(mut transform) = query.single_mut() else {
        return;
    };

    let mut dir = Vec3::ZERO;
    if keyboard.pressed(KeyCode::KeyW) {
        dir.z -= 1.0;
    }
    if keyboard.pressed(KeyCode::KeyS) {
        dir.z += 1.0;
    }
    if keyboard.pressed(KeyCode::KeyA) {
        dir.x -= 1.0;
    }
    if keyboard.pressed(KeyCode::KeyD) {
        dir.x += 1.0;
    }

    if dir != Vec3::ZERO {
        transform.translation += dir.normalize() * MOVE_SPEED * time.delta_secs();
    }
}

/// Hard-offset follow camera (no smoothing — see feel notes).
fn follow_camera(
    player: Query<&Transform, (With<Player>, Without<FollowCamera>)>,
    mut camera: Query<&mut Transform, With<FollowCamera>>,
) {
    let (Ok(player), Ok(mut cam)) = (player.single(), camera.single_mut()) else {
        return;
    };
    cam.translation = player.translation + CAMERA_OFFSET;
    cam.look_at(player.translation, Vec3::Y);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Headless proof that WASD updates the player Transform (no window/GPU).
    #[test]
    fn move_player_advances_transform_on_input() {
        let mut app = App::new();
        app.add_plugins(MinimalPlugins);
        app.init_resource::<ButtonInput<KeyCode>>();

        // Press W.
        app.world_mut()
            .resource_mut::<ButtonInput<KeyCode>>()
            .press(KeyCode::KeyW);

        let player = app
            .world_mut()
            .spawn((Player, Transform::from_xyz(0.0, 1.0, 0.0)))
            .id();

        app.add_systems(Update, move_player);
        // Two updates so `Time` has a non-zero delta after its first tick.
        app.update();
        app.update();

        let z = app.world().get::<Transform>(player).unwrap().translation.z;
        assert!(z < 0.0, "pressing W should move the player toward -Z, got z={z}");
    }
}
