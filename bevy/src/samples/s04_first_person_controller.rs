//! # s04 — First-person controller
//!
//! **What it demonstrates:** A first-person camera where the `Camera3d` *is* the
//! player's eye. You look with the (pointer-locked) mouse and move with WASD
//! relative to where you're looking, with kinematic gravity + a jump — no physics
//! engine, just a vertical velocity integrated against a flat floor at eye
//! height. The horizontal move direction is the shared world-axis [`MoveIntent`]
//! rotated by the look yaw, so "forward" always follows the camera.
//!
//! **Controls:** Click to lock the mouse. `W/A/S/D` move (yaw-relative).
//! `Mouse` looks. `Space` jumps. `Esc` returns to the menu (which releases the
//! cursor + resets look via the shared input plugin).
//!
//! **Feel notes:** Mouse-look is crisp and the yaw-relative WASD reads correctly
//! — strafing and turning feel like a normal FPS. Honest bad parts: movement is
//! instant accel/decel (no inertia), so it's arcade-stiff; there is no head-bob
//! or view smoothing, which makes walking feel "floaty/on-rails" rather than
//! grounded. Gravity uses a single flat floor at eye height with no collision, so
//! you walk straight through the reference boxes and the jump arc is the only
//! vertical interest — landing is an instant snap (no squash/landing lag), which
//! feels abrupt the moment you expect weight. Pitch is pre-clamped by the shared
//! input module so you can't flip over, which is correct but also means you can't
//! lean past vertical for effect.
//!
//! **Bevy 0.18 gotchas:**
//!   * Spawn the eye with `Camera3d::default()` + `Transform` directly — no
//!     `Camera3dBundle`.
//!   * Build the look orientation with `Quat::from_euler(EulerRot::YXZ, yaw,
//!     pitch, 0.0)`: yaw about Y then pitch about the *local* X, zero roll. Using
//!     `XYZ` order here would tilt the horizon when pitched.
//!   * `Time` delta is `time.delta_secs()` (f32), not `delta_seconds()`.
//!   * `Query::single_mut()` returns `Result` — handle with `let Ok(..) = .. else`.
//!   * Jump is edge-triggered: read `ButtonInput<KeyCode>::just_pressed` (NOT
//!     `pressed`, which would re-fire every frame Space is held).
//!
//! **Shared input:** look/move come from the global [`LookState`]/[`MoveIntent`]
//! resources owned by `engine::input::FoundationInputPlugin` (pointer lock +
//! per-frame accumulation), so this sample never polls the mouse inline. Jump
//! reads `ButtonInput<KeyCode>` directly since it's a one-off edge, not a shared
//! intent.
//!
//! **Shared HUD/scene:** ground, light, and box grid come from `engine::scene`;
//! the controls overlay + FPS counter from `engine::hud`. All are
//! `DespawnOnExit`-scoped internally, so only the eye camera is spawned inline.

use bevy::prelude::*;

use crate::engine::hud;
use crate::engine::input::{LookState, MoveIntent};
use crate::engine::scene;

use super::{AppState, SampleMeta};

pub const META: SampleMeta = SampleMeta {
    id: "04-first-person-controller",
    title: "First-person controller",
    summary: "Pointer-lock mouse look + yaw-relative WASD with kinematic gravity/jump.",
    tags: &["movement", "camera", "first-person", "gravity"],
};

/// Horizontal movement speed (world units / second).
const MOVE_SPEED: f32 = 6.0;
/// Eye height above the floor (world units) — the camera's resting Y.
const EYE_HEIGHT: f32 = 1.7;
/// Gravity acceleration (world units / second^2), pulling the eye down.
const GRAVITY: f32 = -20.0;
/// Upward velocity imparted by a jump (world units / second).
const JUMP_SPEED: f32 = 7.0;
/// Reference-prop box grid dimensions (columns x rows).
const BOX_GRID_COLS: u32 = 3;
const BOX_GRID_ROWS: u32 = 3;

/// The first-person eye. Holds the kinematic vertical velocity integrated by
/// [`apply_gravity_and_jump`]; horizontal motion is stateless (driven straight
/// from [`MoveIntent`]).
#[derive(Component, Default)]
struct Eye {
    /// Current vertical velocity (world units / second). `0` while grounded.
    vertical_velocity: f32,
}

pub struct FirstPersonControllerPlugin;

impl Plugin for FirstPersonControllerPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(OnEnter(AppState::S04FirstPersonController), setup)
            .add_systems(
                Update,
                (aim_eye, move_eye, apply_gravity_and_jump)
                    .chain()
                    .run_if(in_state(AppState::S04FirstPersonController)),
            );
    }
}

fn setup(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    let state = AppState::S04FirstPersonController;

    // Shared scene primitives (each DespawnOnExit-scoped internally).
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

    // The eye camera (sample-specific). Starts at eye height, looking down -Z.
    commands.spawn((
        Eye::default(),
        Camera3d::default(),
        Transform::from_xyz(0.0, EYE_HEIGHT, 8.0),
        DespawnOnExit(state),
    ));

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

/// Orients the eye from the shared [`LookState`]: yaw about world Y then pitch
/// about the local X (`EulerRot::YXZ`, zero roll), so the horizon stays level.
fn aim_eye(look: Res<LookState>, mut query: Query<&mut Transform, With<Eye>>) {
    let Ok(mut transform) = query.single_mut() else {
        return;
    };
    transform.rotation = Quat::from_euler(EulerRot::YXZ, look.yaw, look.pitch, 0.0);
}

/// Moves the eye horizontally from the shared world-axis [`MoveIntent`] rotated
/// by the look yaw, so "forward" (W) goes where the camera faces on the XZ plane.
/// Vertical motion is owned by [`apply_gravity_and_jump`]; this never touches Y.
fn move_eye(
    time: Res<Time>,
    look: Res<LookState>,
    intent: Res<MoveIntent>,
    mut query: Query<&mut Transform, With<Eye>>,
) {
    let Ok(mut transform) = query.single_mut() else {
        return;
    };
    if intent.dir == Vec3::ZERO {
        return;
    }
    // Rotate the world-axis intent into yaw-relative space (Y rotation only, so
    // looking up/down never tilts movement off the horizontal plane).
    let world_dir = Quat::from_rotation_y(look.yaw) * intent.dir;
    transform.translation += world_dir * MOVE_SPEED * time.delta_secs();
}

/// Kinematic gravity + jump on the eye's Y. Reads the edge-triggered jump and
/// the frame delta, then delegates the integration to the pure [`step_vertical`]
/// helper so the mechanic is testable headless without a window/`Time` schedule.
fn apply_gravity_and_jump(
    time: Res<Time>,
    keyboard: Res<ButtonInput<KeyCode>>,
    mut query: Query<(&mut Transform, &mut Eye)>,
) {
    let Ok((mut transform, mut eye)) = query.single_mut() else {
        return;
    };
    // Edge-triggered: `just_pressed` so holding Space doesn't re-fire the jump.
    let jump = keyboard.just_pressed(KeyCode::Space);
    let (y, v) = step_vertical(
        transform.translation.y,
        eye.vertical_velocity,
        jump,
        time.delta_secs(),
    );
    transform.translation.y = y;
    eye.vertical_velocity = v;
}

/// Pure one-step integrator for the eye's vertical motion: applies an edge-
/// triggered jump while grounded, integrates [`GRAVITY`] over `dt`, and snaps to
/// the floor at [`EYE_HEIGHT`]. Returns the new `(y, vertical_velocity)`.
///
/// Extracted (no ECS) so headless tests can simulate the jump arc with a fixed
/// `dt` — a tight `app.update()` loop only advances Time by wall-clock
/// microseconds, too little for gravity to play out.
fn step_vertical(y: f32, mut velocity: f32, jump: bool, dt: f32) -> (f32, f32) {
    let grounded = y <= EYE_HEIGHT + f32::EPSILON;
    if grounded && jump {
        velocity = JUMP_SPEED;
    }
    velocity += GRAVITY * dt;
    let mut new_y = y + velocity * dt;
    if new_y <= EYE_HEIGHT {
        new_y = EYE_HEIGHT;
        velocity = 0.0;
    }
    (new_y, velocity)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Headless proof that horizontal movement is yaw-relative: with the eye
    /// yawed 90° left and a forward (`-Z`) [`MoveIntent`], the eye advances along
    /// world `-X` (where it is now looking), not `-Z`.
    #[test]
    fn move_eye_follows_look_yaw() {
        let mut app = App::new();
        app.add_plugins(MinimalPlugins);

        // Yaw +90° (about Y); forward intent (W = -Z), normalized as shared input does.
        app.insert_resource(LookState {
            yaw: std::f32::consts::FRAC_PI_2,
            pitch: 0.0,
            delta: Vec2::ZERO,
        });
        app.insert_resource(MoveIntent {
            dir: Vec3::new(0.0, 0.0, -1.0),
        });

        let eye = app
            .world_mut()
            .spawn((Eye::default(), Transform::from_xyz(0.0, EYE_HEIGHT, 0.0)))
            .id();

        app.add_systems(Update, move_eye);
        // Two updates so `Time` has a non-zero delta after its first tick.
        app.update();
        app.update();

        let t = app.world().get::<Transform>(eye).unwrap().translation;
        // Quat::from_rotation_y(+90°) * (0,0,-1) = (-1,0,0): forward now points -X.
        assert!(
            t.x < 0.0,
            "yawed +90° left, forward intent should move toward -X, got x={}",
            t.x
        );
        assert!(
            t.z.abs() < 1e-3,
            "movement should stay off the original -Z axis when yawed, got z={}",
            t.z
        );
    }

    /// Headless proof of the jump arc via the pure [`step_vertical`] integrator
    /// with a fixed `dt`: a grounded jump raises the eye above eye height, then
    /// gravity pulls it back down and snaps it to the floor (velocity zeroed). A
    /// real `app.update()` loop only advances Time by wall-clock microseconds,
    /// far too little for gravity to play out — hence the fixed step here.
    #[test]
    fn jump_then_gravity_returns_to_floor() {
        let dt = 1.0 / 60.0;

        // First step: grounded + jump pressed -> the eye lifts off the floor.
        let (mut y, mut v) = step_vertical(EYE_HEIGHT, 0.0, true, dt);
        assert!(
            y > EYE_HEIGHT,
            "a grounded jump should raise the eye above {EYE_HEIGHT}, got y={y}"
        );
        assert!(v > 0.0, "velocity should be upward right after the jump, got v={v}");

        // No further jumps; integrate gravity until it settles.
        let mut peak = y;
        for _ in 0..200 {
            (y, v) = step_vertical(y, v, false, dt);
            peak = peak.max(y);
        }

        assert!(
            peak > EYE_HEIGHT + 0.5,
            "the jump arc should rise meaningfully above the floor, peak={peak}"
        );
        assert!(
            (y - EYE_HEIGHT).abs() < 1e-6,
            "gravity should settle the eye exactly onto the floor at {EYE_HEIGHT}, got y={y}"
        );
        assert_eq!(v, 0.0, "velocity must be zeroed once grounded, got v={v}");
    }

    /// A jump only fires while grounded: pressing Space mid-air (above the floor)
    /// must NOT reset the velocity to [`JUMP_SPEED`] (no double-jump).
    #[test]
    fn jump_ignored_while_airborne() {
        let dt = 1.0 / 60.0;
        // Airborne: above the floor with some downward velocity.
        let airborne_y = EYE_HEIGHT + 1.0;
        let (_, v) = step_vertical(airborne_y, -2.0, true, dt);
        assert!(
            v < 0.0,
            "an airborne jump press must be ignored (no double-jump), got v={v}"
        );
    }
}
