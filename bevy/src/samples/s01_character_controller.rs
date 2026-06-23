//! # s01 — Third-person character controller
//!
//! **What it demonstrates:** A capsule "player" you drive with WASD (camera-
//! relative), look around with the pointer-locked mouse, and jump with `Space`
//! under kinematic gravity, trailed by a spherical follow camera that orbits the
//! player from the look yaw/pitch. A small grid of boxes are static reference
//! props. Movement is Transform-based (no physics engine) — the simplest faithful
//! version of the mechanic, good for judging raw control feel before adding
//! collision. This mirrors the Three.js / Babylon.js `01` peers (mouse-look +
//! Space jump + gravity + orbit follow cam), not a movement-only subset.
//!
//! **Controls:** Click to lock the mouse. `W/A/S/D` move (camera-relative on the
//! XZ plane). `Mouse` looks. `Space` jumps. `Esc` returns to the menu (which
//! releases the cursor + resets look via the shared input plugin).
//!
//! **Feel notes:** Instant accel/decel = very responsive but "slidey-free" and
//! arcade-stiff; real games add accel ramps + a small camera lag. The follow
//! camera here is a hard orbit (no smoothing), so fast direction changes look
//! snappy but slightly robotic — the same honest weakness the 12 tiny-planet
//! sample fixes with exponential damping. Gravity uses a single flat floor at the
//! capsule's resting height with no collision, so the capsule drives straight
//! through the boxes (they read as floating reference markers, not obstacles) and
//! landing is an instant snap (no squash/landing lag), which feels abrupt the
//! moment you expect weight. Document all of these when iterating.
//!
//! **Bevy 0.18 gotchas:**
//!   * Spawn meshes with `Mesh3d(handle)` + `MeshMaterial3d(handle)` — the old
//!     `PbrBundle` is gone.
//!   * Scoped cleanup uses `DespawnOnExit(state)` (0.18), NOT `StateScoped`.
//!   * `Time` delta is `time.delta_secs()` (f32), not the old `delta_seconds()`.
//!   * Jump is edge-triggered: read `ButtonInput<KeyCode>::just_pressed` (NOT
//!     `pressed`, which would re-fire every frame Space is held).
//!   * Pitch is clamped *globally* by the shared input module (≈ ±90° to avoid
//!     gimbal flip). This sample additionally clamps the pitch it feeds the
//!     orbit camera to a tighter range so the camera never dips under the floor
//!     or swings directly overhead.
//!
//! **Shared input:** look/move come from the global [`LookState`]/[`MoveIntent`]
//! resources owned by `engine::input::FoundationInputPlugin` (pointer lock +
//! per-frame accumulation), so this sample never polls the mouse inline. The
//! world-axis [`MoveIntent`] is rotated by the look yaw to make WASD camera-
//! relative. Jump reads `ButtonInput<KeyCode>` directly since it's a one-off
//! edge, not a shared intent.
//!
//! **Shared HUD:** this is the reference consumer of `engine::hud` — `setup`
//! calls `spawn_controls_overlay` + `spawn_fps_counter`, both `DespawnOnExit`-
//! scoped internally, so the HUD auto-cleans on `Esc` with no teardown here.
//!
//! **Shared scene:** likewise the reference consumer of `engine::scene` — the
//! ground, directional light, and box grid come from `spawn_ground` /
//! `spawn_light_preset` / `spawn_box_grid`, all `DespawnOnExit`-scoped
//! internally. Only the sample-specific player capsule + follow camera are
//! spawned inline here.

use bevy::prelude::*;

use crate::engine::hud;
use crate::engine::input::{LookState, MoveIntent};
use crate::engine::scene;

use super::{AppState, SampleMeta};

pub const META: SampleMeta = SampleMeta {
    id: "01-character-controller",
    title: "Third-person character controller",
    summary: "WASD-drive a capsule with mouse-look, jump + gravity, and an orbit follow camera.",
    tags: &["movement", "camera", "transform", "gravity"],
};

/// Player movement speed in world units / second.
const MOVE_SPEED: f32 = 6.0;
/// Gravity acceleration (world units / second^2), pulling the player down.
const GRAVITY: f32 = -22.0;
/// Upward velocity imparted by a jump (world units / second).
const JUMP_SPEED: f32 = 9.0;
/// Resting Y of the capsule's center = its half-height (cylinder half + radius),
/// for `Capsule3d::new(0.5, 1.0)` that's `0.5 + 0.5`. Also the kinematic floor.
const PLAYER_FLOOR: f32 = 1.0;
/// Follow-camera distance behind the player (world units).
const CAMERA_DISTANCE: f32 = 6.0;
/// Follow-camera height above the player (world units).
const CAMERA_HEIGHT: f32 = 3.0;
/// Height above the player the camera aims at (so it frames the torso/head).
const LOOK_AT_HEIGHT: f32 = 0.5;
/// Tighter pitch clamp for the orbit camera (radians): keeps it from dipping
/// under the floor or swinging straight overhead. Narrower than the shared
/// input module's global ±90° look clamp.
const CAM_PITCH_MIN: f32 = -0.4;
const CAM_PITCH_MAX: f32 = 1.2;
/// Reference-prop box grid dimensions (columns x rows).
const BOX_GRID_COLS: u32 = 3;
const BOX_GRID_ROWS: u32 = 3;

/// The player capsule. Holds the kinematic vertical velocity integrated by
/// [`move_player`]; horizontal motion is stateless (driven from [`MoveIntent`]).
#[derive(Component, Default)]
struct Player {
    /// Current vertical velocity (world units / second). `0` while grounded.
    vertical_velocity: f32,
}

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
    let state = AppState::S01CharacterController;
    let scope = DespawnOnExit(state);

    // Shared scene primitives: ground + light preset + box grid. Each helper
    // tags its entities `DespawnOnExit(state)` internally, so no teardown here.
    scene::spawn_ground(&mut commands, &mut meshes, &mut materials, state);
    scene::spawn_light_preset(&mut commands, state);
    scene::spawn_box_grid(
        &mut commands,
        &mut meshes,
        &mut materials,
        state,
        BOX_GRID_COLS,
        BOX_GRID_ROWS,
    );

    // Player capsule (sample-specific), resting on the floor.
    commands.spawn((
        Player::default(),
        Mesh3d(meshes.add(Capsule3d::new(0.5, 1.0))),
        MeshMaterial3d(materials.add(StandardMaterial {
            base_color: Color::srgb(0.2, 0.5, 0.9),
            ..default()
        })),
        Transform::from_xyz(0.0, PLAYER_FLOOR, 0.0),
        scope.clone(),
    ));

    // Follow camera (sample-specific). `follow_camera` repositions it every
    // frame; this initial pose just avoids a one-frame jump at the origin.
    commands.spawn((
        FollowCamera,
        Camera3d::default(),
        Transform::from_xyz(0.0, CAMERA_HEIGHT, CAMERA_DISTANCE)
            .looking_at(Vec3::Y * LOOK_AT_HEIGHT, Vec3::Y),
        scope,
    ));

    // Shared HUD: controls overlay (bottom-left) + FPS counter (top-right).
    // Both tag themselves `DespawnOnExit(state)` internally, so no teardown here.
    hud::spawn_controls_overlay(
        &mut commands,
        state,
        &[
            "Click — lock mouse",
            "WASD — move",
            "Mouse — look",
            "Space — jump",
            "Esc — back to menu",
        ],
    );
    hud::spawn_fps_counter(&mut commands, state);
}

/// Drives the player: camera-relative WASD on the XZ plane (the world-axis
/// [`MoveIntent`] rotated by the look yaw, so looking up/down never tilts
/// movement), faces the look yaw, and integrates the edge-triggered jump +
/// gravity via the pure [`step_vertical`] helper.
fn move_player(
    time: Res<Time>,
    look: Res<LookState>,
    intent: Res<MoveIntent>,
    keyboard: Res<ButtonInput<KeyCode>>,
    mut query: Query<(&mut Transform, &mut Player)>,
) {
    let Ok((mut transform, mut player)) = query.single_mut() else {
        return;
    };
    let dt = time.delta_secs();

    // Horizontal: rotate the world-axis intent into yaw-relative space (Y
    // rotation only) so "forward" (W) always goes where the camera faces.
    if intent.dir != Vec3::ZERO {
        let world_dir = Quat::from_rotation_y(look.yaw) * intent.dir;
        transform.translation += world_dir * MOVE_SPEED * dt;
    }

    // Face the look yaw (cosmetic on a symmetric capsule, kept for parity with
    // the Three/Babylon peers which rotate the player mesh to the heading).
    transform.rotation = Quat::from_rotation_y(look.yaw);

    // Vertical: edge-triggered jump (`just_pressed` so holding Space doesn't
    // re-fire) + gravity, integrated by the pure, headless-testable helper.
    let jump = keyboard.just_pressed(KeyCode::Space);
    let (y, v) = step_vertical(transform.translation.y, player.vertical_velocity, jump, dt);
    transform.translation.y = y;
    player.vertical_velocity = v;
}

/// Pure one-step integrator for the player's vertical motion: applies an edge-
/// triggered jump while grounded, integrates [`GRAVITY`] over `dt`, and snaps to
/// the floor at [`PLAYER_FLOOR`]. Returns the new `(y, vertical_velocity)`.
///
/// Extracted (no ECS) so headless tests can simulate the jump arc with a fixed
/// `dt` — a tight `app.update()` loop only advances Time by wall-clock
/// microseconds, too little for gravity to play out.
fn step_vertical(y: f32, mut velocity: f32, jump: bool, dt: f32) -> (f32, f32) {
    let grounded = y <= PLAYER_FLOOR + f32::EPSILON;
    if grounded && jump {
        velocity = JUMP_SPEED;
    }
    velocity += GRAVITY * dt;
    let mut new_y = y + velocity * dt;
    if new_y <= PLAYER_FLOOR {
        new_y = PLAYER_FLOOR;
        velocity = 0.0;
    }
    (new_y, velocity)
}

/// Spherical follow camera: orbits behind the player from the look yaw/pitch,
/// distance [`CAMERA_DISTANCE`], raised by [`CAMERA_HEIGHT`], aiming a little
/// above the player. The "behind" direction is the look orientation's +Z, which
/// is exactly the opposite of the player's forward (`-Z`), so pressing W always
/// drives the player away from the camera.
fn follow_camera(
    look: Res<LookState>,
    player: Query<&Transform, (With<Player>, Without<FollowCamera>)>,
    mut camera: Query<&mut Transform, With<FollowCamera>>,
) {
    let (Ok(player), Ok(mut cam)) = (player.single(), camera.single_mut()) else {
        return;
    };
    let pitch = look.pitch.clamp(CAM_PITCH_MIN, CAM_PITCH_MAX);
    // +Z of the yaw/pitch orientation points "behind" the look direction.
    let behind = Quat::from_euler(EulerRot::YXZ, look.yaw, pitch, 0.0) * Vec3::Z;
    cam.translation = player.translation + behind * CAMERA_DISTANCE + Vec3::Y * CAMERA_HEIGHT;
    cam.look_at(player.translation + Vec3::Y * LOOK_AT_HEIGHT, Vec3::Y);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Headless proof that horizontal movement is yaw-relative: with the player
    /// yawed +90° and a forward (`-Z`) [`MoveIntent`], it advances along world
    /// `-X` (where the camera now faces), not `-Z`. Mirrors s04's coverage.
    #[test]
    fn move_player_is_yaw_relative() {
        let mut app = App::new();
        app.add_plugins(MinimalPlugins);
        app.init_resource::<ButtonInput<KeyCode>>();
        app.insert_resource(LookState {
            yaw: std::f32::consts::FRAC_PI_2,
            pitch: 0.0,
            delta: Vec2::ZERO,
        });
        app.insert_resource(MoveIntent {
            dir: Vec3::new(0.0, 0.0, -1.0),
        });

        let player = app
            .world_mut()
            .spawn((Player::default(), Transform::from_xyz(0.0, PLAYER_FLOOR, 0.0)))
            .id();

        app.add_systems(Update, move_player);
        // Two updates so `Time` has a non-zero delta after its first tick.
        app.update();
        app.update();

        let t = app.world().get::<Transform>(player).unwrap().translation;
        // Quat::from_rotation_y(+90°) * (0,0,-1) = (-1,0,0): forward now points -X.
        assert!(
            t.x < 0.0,
            "yawed +90°, forward intent should move toward -X, got x={}",
            t.x
        );
        assert!(
            t.z.abs() < 1e-3,
            "movement should stay off the original -Z axis when yawed, got z={}",
            t.z
        );
    }

    /// Headless proof of the jump arc via the pure [`step_vertical`] integrator
    /// with a fixed `dt`: a grounded jump raises the player above the floor, then
    /// gravity pulls it back down and snaps it to the floor (velocity zeroed).
    #[test]
    fn jump_then_gravity_returns_to_floor() {
        let dt = 1.0 / 60.0;

        // First step: grounded + jump pressed -> the player lifts off the floor.
        let (mut y, mut v) = step_vertical(PLAYER_FLOOR, 0.0, true, dt);
        assert!(
            y > PLAYER_FLOOR,
            "a grounded jump should raise the player above {PLAYER_FLOOR}, got y={y}"
        );
        assert!(v > 0.0, "velocity should be upward right after the jump, got v={v}");

        // No further jumps; integrate gravity until it settles.
        let mut peak = y;
        for _ in 0..200 {
            (y, v) = step_vertical(y, v, false, dt);
            peak = peak.max(y);
        }

        assert!(
            peak > PLAYER_FLOOR + 0.5,
            "the jump arc should rise meaningfully above the floor, peak={peak}"
        );
        assert!(
            (y - PLAYER_FLOOR).abs() < 1e-6,
            "gravity should settle the player exactly onto the floor at {PLAYER_FLOOR}, got y={y}"
        );
        assert_eq!(v, 0.0, "velocity must be zeroed once grounded, got v={v}");
    }

    /// A jump only fires while grounded: pressing Space mid-air must NOT reset
    /// the velocity to [`JUMP_SPEED`] (no double-jump).
    #[test]
    fn jump_ignored_while_airborne() {
        let dt = 1.0 / 60.0;
        let airborne_y = PLAYER_FLOOR + 1.0;
        let (_, v) = step_vertical(airborne_y, -2.0, true, dt);
        assert!(
            v < 0.0,
            "an airborne jump press must be ignored (no double-jump), got v={v}"
        );
    }
}
