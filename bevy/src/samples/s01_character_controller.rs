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
//!
//! **Shared input:** movement reads the global [`MoveIntent`] resource owned by
//! `engine::input::FoundationInputPlugin` instead of polling `ButtonInput` here,
//! so every sample shares one keyboard-intent definition.
//!
//! **Shared HUD:** this is the reference consumer of `engine::hud` — `setup`
//! calls `spawn_controls_overlay` + `spawn_fps_counter`, both `DespawnOnExit`-
//! scoped internally, so the HUD auto-cleans on `Esc` with no teardown here.

use bevy::prelude::*;

use crate::engine::hud;
use crate::engine::input::MoveIntent;

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

    // Shared HUD: controls overlay (bottom-left) + FPS counter (top-right).
    // Both tag themselves `DespawnOnExit(state)` internally, so no teardown here.
    let state = AppState::S01CharacterController;
    hud::spawn_controls_overlay(&mut commands, state, &["WASD — move", "Esc — back to menu"]);
    hud::spawn_fps_counter(&mut commands, state);
}

/// Moves the player on the XZ plane from the shared [`MoveIntent`] (world axes,
/// W = -Z). The intent is already normalized by the shared input module, so this
/// sample only scales it by speed and frame time.
fn move_player(
    time: Res<Time>,
    intent: Res<MoveIntent>,
    mut query: Query<&mut Transform, With<Player>>,
) {
    let Ok(mut transform) = query.single_mut() else {
        return;
    };

    if intent.dir != Vec3::ZERO {
        transform.translation += intent.dir * MOVE_SPEED * time.delta_secs();
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

    /// Headless proof that the player Transform advances from the shared
    /// `MoveIntent` resource (no window/GPU). Mirrors the shared input path:
    /// the global plugin populates `MoveIntent`; this sample consumes it.
    #[test]
    fn move_player_advances_transform_from_intent() {
        let mut app = App::new();
        app.add_plugins(MinimalPlugins);

        // Forward intent (W = -Z), already normalized as the shared module does.
        app.insert_resource(MoveIntent {
            dir: Vec3::new(0.0, 0.0, -1.0),
        });

        let player = app
            .world_mut()
            .spawn((Player, Transform::from_xyz(0.0, 1.0, 0.0)))
            .id();

        app.add_systems(Update, move_player);
        // Two updates so `Time` has a non-zero delta after its first tick.
        app.update();
        app.update();

        let z = app.world().get::<Transform>(player).unwrap().translation.z;
        assert!(z < 0.0, "forward intent should move the player toward -Z, got z={z}");
    }
}
