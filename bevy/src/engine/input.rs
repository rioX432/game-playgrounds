//! Shared foundation input module (keyboard intent + pointer-lock mouse look).
//!
//! This is a **global** plugin added ONCE in `main.rs` (not per-sample). It owns
//! all non-entity input state as Resources so every sample can read a clean,
//! engine-agnostic intent instead of polling `ButtonInput<KeyCode>` and mouse
//! motion inline:
//!
//!   * [`MoveIntent`] — WASD direction on the XZ plane (`Vec3`, normalized when
//!     non-zero), refreshed every frame.
//!   * [`LookState`] — accumulated yaw/pitch (radians) from mouse motion plus the
//!     per-frame `delta`, refreshed every frame while pointer-lock is active.
//!   * [`PointerLock`] — whether the OS cursor is currently grabbed.
//!
//! ## Pointer lock ownership
//! The module (NOT samples) grabs/releases the OS cursor via the primary
//! window's `CursorOptions` component. Pointer lock is auto-engaged on entering
//! any sample and released on returning to the menu.
//!
//! ## Cleanup contract (the `dispose()` equivalent — CRITICAL)
//! `DespawnOnExit` only despawns entities; it does NOT release a grabbed cursor
//! or reset these resources. So `OnEnter(AppState::Menu)` runs [`release_input`]:
//! it ungrabs + shows the cursor, zeroes accumulated look + per-frame delta, and
//! resets intent to menu-safe defaults. The transient `LookState::delta` is also
//! cleared every frame so it never leaks across frames. A sample switch must
//! NEVER leave the cursor locked or stale look state behind.
//!
//! ## Bevy 0.18 gotchas (verified against avvy-world)
//!   * `CursorOptions` is a **sibling component** on the primary window entity
//!     (`Query<&mut CursorOptions, With<PrimaryWindow>>`), NOT a field on
//!     `Window` as in older Bevy.
//!   * Mouse motion is read from `Res<AccumulatedMouseMotion>` (`.delta: Vec2`),
//!     not by draining `MouseMotion` events.
//!   * `ButtonInput<KeyCode>` for keys; `Query::single()` returns `Result`.

use bevy::input::mouse::AccumulatedMouseMotion;
use bevy::prelude::*;
use bevy::window::{CursorGrabMode, CursorOptions, PrimaryWindow};

use crate::samples::AppState;

/// Default look sensitivity (radians per pixel of mouse motion).
const LOOK_SENSITIVITY: f32 = 0.003;
/// Pitch is clamped just shy of straight up/down to avoid gimbal flip.
const PITCH_LIMIT: f32 = std::f32::consts::FRAC_PI_2 - 0.01;

/// WASD movement intent on the XZ plane, in world axes (W = -Z). Normalized when
/// non-zero, `Vec3::ZERO` when no key is held. Refreshed every frame.
#[derive(Resource, Debug, Clone, Copy, Default, PartialEq)]
pub struct MoveIntent {
    /// Desired movement direction (XZ plane). `y` is always 0.
    pub dir: Vec3,
}

/// Accumulated look orientation from mouse motion plus the latest per-frame
/// delta. `yaw`/`pitch` persist across frames; `delta` is reset every frame.
#[derive(Resource, Debug, Clone, Copy, Default)]
pub struct LookState {
    /// Accumulated yaw in radians (left/right). Grows unbounded.
    pub yaw: f32,
    /// Accumulated pitch in radians (up/down), clamped to +/- [`PITCH_LIMIT`].
    pub pitch: f32,
    /// This frame's raw mouse delta (pixels). Transient — cleared each frame.
    pub delta: Vec2,
}

/// Whether the OS cursor is currently grabbed (pointer-lock engaged).
#[derive(Resource, Debug, Clone, Copy, Default)]
pub struct PointerLock {
    /// `true` while the cursor is locked + hidden for mouse-look.
    pub locked: bool,
}

/// Global input plugin. Add ONCE in `main.rs`. Owns keyboard intent, mouse-look
/// accumulation, and pointer-lock lifecycle for the whole gallery.
pub struct FoundationInputPlugin;

impl Plugin for FoundationInputPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<MoveIntent>()
            .init_resource::<LookState>()
            .init_resource::<PointerLock>()
            // Release the cursor + reset state when returning to the menu.
            .add_systems(OnEnter(AppState::Menu), release_input)
            // Per-frame input population, only while inside a sample. Ordered so
            // `update_look` runs BEFORE `grab_cursor_on_sample_enter`: on the
            // first sample frame the pointer is not yet locked, so look skips the
            // mouse motion accumulated during the menu click; the grab then
            // engages and look starts accumulating from the next frame.
            .add_systems(
                Update,
                (update_move_intent, update_look, grab_cursor_on_sample_enter)
                    .chain()
                    .run_if(not(in_state(AppState::Menu))),
            );
    }
}

/// Engages pointer lock the first frame a sample is active (idempotent: only
/// touches the window when `PointerLock` is not already locked, so the OS cursor
/// does not flicker every frame). Kept in `Update` (not `OnEnter`) so a single
/// system owns the window write while a sample runs.
fn grab_cursor_on_sample_enter(
    mut pointer: ResMut<PointerLock>,
    mut cursor_query: Query<&mut CursorOptions, With<PrimaryWindow>>,
) {
    if pointer.locked {
        return;
    }
    let Ok(mut cursor) = cursor_query.single_mut() else {
        return;
    };
    cursor.grab_mode = CursorGrabMode::Locked;
    cursor.visible = false;
    pointer.locked = true;
}

/// Populates [`MoveIntent`] from WASD (world axes, W = -Z). Pure resource write;
/// samples read `MoveIntent.dir` instead of polling the keyboard.
fn update_move_intent(keyboard: Res<ButtonInput<KeyCode>>, mut intent: ResMut<MoveIntent>) {
    intent.dir = read_wasd(&keyboard);
}

/// Pure helper: maps the WASD key state to a normalized XZ direction (W = -Z,
/// S = +Z, A = -X, D = +X). Extracted so headless tests can exercise it without
/// the full system + window.
fn read_wasd(keyboard: &ButtonInput<KeyCode>) -> Vec3 {
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
        dir = dir.normalize();
    }
    dir
}

/// Accumulates yaw/pitch from this frame's mouse delta into [`LookState`] and
/// stores the raw delta. The delta is reset to zero every frame regardless of
/// motion so it never leaks into a later frame (or a later sample).
///
/// Look only accumulates while the pointer is locked. This skips the very first
/// sample frame (lock not yet engaged — see system ordering in [`Plugin::build`])
/// so the mouse motion accumulated during the menu click never produces a
/// one-frame camera jolt on sample entry.
fn update_look(
    pointer: Res<PointerLock>,
    mouse_motion: Res<AccumulatedMouseMotion>,
    mut look: ResMut<LookState>,
) {
    if !pointer.locked {
        look.delta = Vec2::ZERO;
        return;
    }
    let delta = mouse_motion.delta;
    look.delta = delta;
    look.yaw -= delta.x * LOOK_SENSITIVITY;
    look.pitch = (look.pitch - delta.y * LOOK_SENSITIVITY).clamp(-PITCH_LIMIT, PITCH_LIMIT);
}

/// The `dispose()` equivalent: releases the cursor and resets all input state to
/// menu-safe defaults on returning to the menu. Runs on `OnEnter(AppState::Menu)`
/// so a sample switch never leaves the cursor locked or stale look state behind.
fn release_input(
    mut pointer: ResMut<PointerLock>,
    mut look: ResMut<LookState>,
    mut intent: ResMut<MoveIntent>,
    mut cursor_query: Query<&mut CursorOptions, With<PrimaryWindow>>,
) {
    if let Ok(mut cursor) = cursor_query.single_mut() {
        cursor.grab_mode = CursorGrabMode::None;
        cursor.visible = true;
    }
    pointer.locked = false;
    *look = LookState::default();
    *intent = MoveIntent::default();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Headless proof that the shared `MoveIntent` resource updates from
    /// keyboard input via the global system (no window/GPU).
    #[test]
    fn move_intent_updates_from_keyboard() {
        let mut app = App::new();
        app.add_plugins(MinimalPlugins);
        app.init_resource::<ButtonInput<KeyCode>>();
        app.init_resource::<MoveIntent>();
        app.add_systems(Update, update_move_intent);

        // Press W.
        app.world_mut()
            .resource_mut::<ButtonInput<KeyCode>>()
            .press(KeyCode::KeyW);
        app.update();

        let intent = *app.world().resource::<MoveIntent>();
        assert!(
            intent.dir.z < 0.0,
            "pressing W should drive intent toward -Z, got {:?}",
            intent.dir
        );
        assert!(
            (intent.dir.length() - 1.0).abs() < 1e-5,
            "non-zero intent must be normalized, got len {}",
            intent.dir.length()
        );
    }

    /// No keys held => zero intent (menu-safe default).
    #[test]
    fn move_intent_is_zero_with_no_keys() {
        let kb = ButtonInput::<KeyCode>::default();
        assert_eq!(read_wasd(&kb), Vec3::ZERO);
    }

    /// `update_look` ignores mouse motion until the pointer is locked, so the
    /// menu-click motion on the first sample frame cannot jolt the camera.
    #[test]
    fn look_skips_until_pointer_locked() {
        let mut app = App::new();
        app.add_plugins(MinimalPlugins);
        app.init_resource::<AccumulatedMouseMotion>();
        app.init_resource::<LookState>();
        app.insert_resource(PointerLock { locked: false });
        app.world_mut().resource_mut::<AccumulatedMouseMotion>().delta = Vec2::new(50.0, 20.0);
        app.add_systems(Update, update_look);

        // Not locked yet: the accumulated menu motion must be ignored.
        app.update();
        let look = *app.world().resource::<LookState>();
        assert_eq!(look.yaw, 0.0, "look must not accumulate while unlocked");
        assert_eq!(look.pitch, 0.0);
        assert_eq!(look.delta, Vec2::ZERO);

        // Once locked, the same delta drives yaw/pitch.
        app.world_mut().resource_mut::<PointerLock>().locked = true;
        app.world_mut().resource_mut::<AccumulatedMouseMotion>().delta = Vec2::new(50.0, 20.0);
        app.update();
        let look = *app.world().resource::<LookState>();
        assert!(look.yaw != 0.0, "look must accumulate once locked");
    }

    /// `release_input` resets accumulated look + intent + pointer lock to
    /// menu-safe defaults (the leak contract, sans the window write).
    #[test]
    fn release_input_resets_state() {
        let mut app = App::new();
        app.add_plugins(MinimalPlugins);
        app.insert_resource(LookState {
            yaw: 1.2,
            pitch: 0.4,
            delta: Vec2::new(5.0, 5.0),
        });
        app.insert_resource(MoveIntent {
            dir: Vec3::new(1.0, 0.0, 0.0),
        });
        app.insert_resource(PointerLock { locked: true });
        // No primary window in headless mode — the cursor query is empty, which
        // `release_input` tolerates; resource resets still run.
        app.add_systems(Update, release_input);
        app.update();

        let look = *app.world().resource::<LookState>();
        assert_eq!(look.yaw, 0.0);
        assert_eq!(look.pitch, 0.0);
        assert_eq!(look.delta, Vec2::ZERO);
        assert_eq!(app.world().resource::<MoveIntent>().dir, Vec3::ZERO);
        assert!(!app.world().resource::<PointerLock>().locked);
    }
}
