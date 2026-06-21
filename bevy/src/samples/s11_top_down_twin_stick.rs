//! # s11 — Top-down twin-stick movement
//!
//! **What it demonstrates:** A top-down (slightly tilted) camera over a player
//! you drive with `WASD`, while the player's facing is aimed independently at the
//! mouse cursor. The two channels are fully **decoupled** — you can strafe one
//! direction while the nose points another (the defining twin-stick trait,
//! normally split across two thumbsticks; here the right stick is the mouse).
//! Movement uses **world-axis** WASD (W = forward = -Z) — the standard twin-stick
//! convention where the stick maps to world space, not to the facing.
//!
//! **Controls:** `W/A/S/D` move on the ground plane (world axes). Move the
//! **mouse** to aim — the player rotates to face the cursor's ground point and a
//! reticle marks the aim point. `Esc` returns to the menu.
//!
//! **Feel notes:** Decoupled strafe-while-aiming feels great and reads instantly
//! thanks to the nose indicator + reticle. Instant accel/decel is arcade-snappy
//! but slidey-free (no momentum), like s01. **Where it feels bad:** facing snaps
//! with zero rotation smoothing, so flicking the mouse makes the player rotate
//! instantaneously — crisp but slightly robotic; a real game would slerp toward
//! the target yaw. The tilted top-down camera (not pure overhead) trades a sliver
//! of aim precision near screen edges for much better readability — worth it. When
//! the cursor leaves the window the aim *holds* its last facing rather than
//! snapping to center (intentional: no jitter), which can feel briefly "stuck"
//! until you move back over the window.
//!
//! **Bevy 0.18 gotchas:**
//!   * **Cursor must stay FREE.** The shared `FoundationInputPlugin` auto-grabs +
//!     hides the OS cursor on entering any sample (for mouse-look). Twin-stick
//!     needs the *absolute* cursor visible, so this sample marks the shared
//!     `PointerLock.locked = true` (so the shared grabber skips re-grabbing) and
//!     each frame forces `CursorOptions { grab_mode: None, visible: true }` on the
//!     primary window. Returning to Menu runs the shared `release_input`, which
//!     restores the cursor — no manual exit cleanup here.
//!   * **Cursor → ground ray** uses `Camera::viewport_to_world(&GlobalTransform,
//!     Vec2) -> Result<Ray3d, _>` (0.18 moved `Camera` into the `bevy_camera`
//!     crate; signature returns `Result`, not `Option`). Intersect the ground
//!     with `ray.intersect_plane(Vec3::ZERO, InfinitePlane3d::new(Vec3::Y)) ->
//!     Option<f32>`, then `ray.get_point(dist)`. All `None`/`Err` cases (cursor
//!     off-window, ray parallel) are guarded → no NaN, hold last facing.
//!   * **Facing sign:** Bevy forward is `-Z`. `Quat::from_rotation_y(yaw)` rotates
//!     `-Z` to `(-sin yaw, 0, -cos yaw)`, so to point the nose AT `(dx, dz)` the
//!     yaw is `atan2(-dx, -dz)` (see [`facing_yaw`]). Getting this 180° off is the
//!     classic twin-stick bug.
//!   * Scoped cleanup is `DespawnOnExit(state)` (0.18), NOT `StateScoped`.

use bevy::prelude::*;
use bevy::window::{CursorGrabMode, CursorOptions, PrimaryWindow};

use crate::engine::hud;
use crate::engine::input::{MoveIntent, PointerLock};
use crate::engine::scene;

use super::{AppState, SampleMeta};

pub const META: SampleMeta = SampleMeta {
    id: "11-top-down-twin-stick",
    title: "Top-down twin-stick movement",
    summary: "WASD to move, mouse to aim — movement and facing decoupled.",
    tags: &["movement", "twin-stick", "top-down", "aim"],
};

/// Player movement speed in world units / second.
const MOVE_SPEED: f32 = 6.0;
/// Top-down camera offset above and slightly behind the player (world units).
/// Tilted rather than pure overhead for readability (see feel notes).
const CAMERA_OFFSET: Vec3 = Vec3::new(0.0, 14.0, 6.0);
/// Reference-prop box grid dimensions (columns x rows).
const BOX_GRID_COLS: u32 = 3;
const BOX_GRID_ROWS: u32 = 3;
/// Radius of the small reticle sphere marking the aim point.
const RETICLE_RADIUS: f32 = 0.25;

#[derive(Component)]
struct Player;

#[derive(Component)]
struct TopDownCamera;

/// Reticle marker placed at the cursor's ground point.
#[derive(Component)]
struct Reticle;

/// Per-sample aim state: the last valid ground-aim point. Held across frames so a
/// cursor that leaves the window keeps the last facing (no NaN, no snap-to-center).
#[derive(Resource, Debug, Clone, Copy)]
struct AimState {
    /// Last valid world-space aim point on the ground plane (y = 0).
    point: Vec3,
}

impl Default for AimState {
    fn default() -> Self {
        // Default aim straight ahead of the spawn (-Z) so the nose has a sane
        // initial facing before the first cursor read.
        Self {
            point: Vec3::new(0.0, 0.0, -1.0),
        }
    }
}

pub struct TwinStickPlugin;

impl Plugin for TwinStickPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(OnEnter(AppState::S11TwinStick), setup).add_systems(
            Update,
            (
                free_cursor,
                update_aim,
                face_aim,
                move_player,
                follow_camera,
            )
                .chain()
                .run_if(in_state(AppState::S11TwinStick)),
        );
    }
}

fn setup(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut pointer: ResMut<PointerLock>,
) {
    let state = AppState::S11TwinStick;
    let scope = DespawnOnExit(state);

    // Reset per-sample aim state on entry (OnEnter — never leaks across samples).
    commands.insert_resource(AimState::default());

    // Tell the shared input grabber to stand down: with `locked == true` it skips
    // re-grabbing the cursor every frame, so `free_cursor` below can keep the
    // cursor visible without a per-frame fight. The shared `release_input` on
    // returning to Menu resets this back to `false`.
    pointer.locked = true;

    // Shared scene primitives (each tags itself DespawnOnExit(state) internally).
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

    // Player body (cylinder) + a "nose" child marking forward (-Z) so the facing
    // is visible. The child is parented, so it despawns with the player.
    let nose_mesh = meshes.add(Cuboid::new(0.25, 0.25, 0.8));
    let nose_material = materials.add(StandardMaterial {
        base_color: Color::srgb(0.95, 0.85, 0.2),
        ..default()
    });
    commands
        .spawn((
            Player,
            Mesh3d(meshes.add(Cylinder::new(0.5, 1.2))),
            MeshMaterial3d(materials.add(StandardMaterial {
                base_color: Color::srgb(0.2, 0.5, 0.9),
                ..default()
            })),
            Transform::from_xyz(0.0, 0.6, 0.0),
            scope.clone(),
        ))
        .with_children(|parent| {
            // Nose sits in front of the body (-Z) at mid-height; rotates with it.
            parent.spawn((
                Mesh3d(nose_mesh),
                MeshMaterial3d(nose_material),
                Transform::from_xyz(0.0, 0.0, -0.7),
            ));
        });

    // Reticle marker at the aim point.
    commands.spawn((
        Reticle,
        Mesh3d(meshes.add(Sphere::new(RETICLE_RADIUS))),
        MeshMaterial3d(materials.add(StandardMaterial {
            base_color: Color::srgb(0.95, 0.2, 0.2),
            ..default()
        })),
        Transform::from_xyz(0.0, RETICLE_RADIUS, -1.0),
        scope.clone(),
    ));

    // Top-down camera (sample-specific), looking down at the player.
    commands.spawn((
        TopDownCamera,
        Camera3d::default(),
        Transform::from_translation(CAMERA_OFFSET).looking_at(Vec3::ZERO, Vec3::Y),
        scope,
    ));

    hud::spawn_controls_overlay(
        &mut commands,
        state,
        &["WASD — move (world axes)", "Mouse — aim", "Esc — back to menu"],
    );
    hud::spawn_fps_counter(&mut commands, state);
}

/// Keeps the OS cursor FREE (visible + ungrabbed) every frame while in this
/// sample, overriding the shared auto-grab. Twin-stick needs the absolute cursor
/// to aim. The shared `release_input` restores normal cursor state on Menu exit.
fn free_cursor(mut cursor_query: Query<&mut CursorOptions, With<PrimaryWindow>>) {
    let Ok(mut cursor) = cursor_query.single_mut() else {
        return;
    };
    if cursor.grab_mode != CursorGrabMode::None {
        cursor.grab_mode = CursorGrabMode::None;
    }
    if !cursor.visible {
        cursor.visible = true;
    }
}

/// Raycasts the cursor onto the ground plane (y = 0) and stores the hit as the
/// aim point + moves the reticle there. Guards every failure (cursor off-window,
/// no camera, ray parallel to ground) by holding the previous [`AimState`] — no
/// NaN, no snap.
fn update_aim(
    window_query: Query<&Window, With<PrimaryWindow>>,
    camera_query: Query<(&Camera, &GlobalTransform), With<TopDownCamera>>,
    mut aim: ResMut<AimState>,
    mut reticle: Query<&mut Transform, With<Reticle>>,
) {
    let Ok(window) = window_query.single() else {
        return;
    };
    let Ok((camera, camera_transform)) = camera_query.single() else {
        return;
    };
    // Cursor outside the window => hold last aim.
    let Some(cursor_pos) = window.cursor_position() else {
        return;
    };
    // viewport_to_world returns Err if the conversion is degenerate => hold.
    let Ok(ray) = camera.viewport_to_world(camera_transform, cursor_pos) else {
        return;
    };
    // Ray parallel to the ground (or pointing away) => None => hold.
    let Some(distance) = ray.intersect_plane(Vec3::ZERO, InfinitePlane3d::new(Vec3::Y)) else {
        return;
    };
    aim.point = ray.get_point(distance);

    if let Ok(mut reticle_transform) = reticle.single_mut() {
        reticle_transform.translation = Vec3::new(aim.point.x, RETICLE_RADIUS, aim.point.z);
    }
}

/// Rotates the player (yaw only) to face the current aim point, INDEPENDENTLY of
/// movement. The math is in [`facing_yaw`] (pure, tested).
fn face_aim(aim: Res<AimState>, mut query: Query<&mut Transform, With<Player>>) {
    let Ok(mut transform) = query.single_mut() else {
        return;
    };
    if let Some(yaw) = facing_yaw(transform.translation, aim.point) {
        transform.rotation = Quat::from_rotation_y(yaw);
    }
}

/// Moves the player on the XZ plane from the shared [`MoveIntent`] (world axes,
/// W = -Z), DECOUPLED from facing. Already normalized by the shared input module.
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

/// Top-down camera follows the player's XZ with a fixed tilted offset (no
/// smoothing — see feel notes).
fn follow_camera(
    player: Query<&Transform, (With<Player>, Without<TopDownCamera>)>,
    mut camera: Query<&mut Transform, With<TopDownCamera>>,
) {
    let (Ok(player), Ok(mut cam)) = (player.single(), camera.single_mut()) else {
        return;
    };
    cam.translation = player.translation + CAMERA_OFFSET;
    cam.look_at(player.translation, Vec3::Y);
}

/// Pure facing math: the yaw (radians) that points the player's forward (-Z) AT
/// `aim` on the XZ plane. Returns `None` when `aim` is within epsilon of `pos`
/// horizontally (degenerate — caller holds the previous facing).
///
/// Derivation: `Quat::from_rotation_y(yaw)` rotates the forward vector `-Z`
/// `(0,0,-1)` to `(-sin yaw, 0, -cos yaw)`. To make that equal the horizontal aim
/// direction `(dx, dz)` we need `-sin yaw = dx` and `-cos yaw = dz`, hence
/// `yaw = atan2(-dx, -dz)`.
fn facing_yaw(pos: Vec3, aim: Vec3) -> Option<f32> {
    let dx = aim.x - pos.x;
    let dz = aim.z - pos.z;
    if dx * dx + dz * dz < 1e-12 {
        return None;
    }
    Some((-dx).atan2(-dz))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The forward vector produced by `facing_yaw` points AT the aim point: its
    /// dot with the horizontal aim direction is positive (nose toward cursor, not
    /// 180° off). Checked at the four cardinal aim directions plus a diagonal.
    #[test]
    fn facing_yaw_points_forward_at_aim() {
        let pos = Vec3::ZERO;
        let aims = [
            Vec3::new(0.0, 0.0, -5.0), // ahead (-Z)
            Vec3::new(0.0, 0.0, 5.0),  // behind (+Z)
            Vec3::new(5.0, 0.0, 0.0),  // right (+X)
            Vec3::new(-5.0, 0.0, 0.0), // left (-X)
            Vec3::new(3.0, 0.0, -4.0), // diagonal
        ];
        for aim in aims {
            let yaw = facing_yaw(pos, aim).expect("non-degenerate aim yields a yaw");
            // Forward of the rotated player (Bevy forward is -Z).
            let forward = Quat::from_rotation_y(yaw) * Vec3::NEG_Z;
            let want = (aim - pos).normalize();
            let dot = forward.dot(want);
            assert!(
                dot > 0.999,
                "nose must point AT the aim (dot ~1), got dot={dot} for aim={aim:?}",
            );
        }
    }

    /// A degenerate aim (coincident with the player on XZ) returns `None` so the
    /// caller holds the previous facing instead of producing NaN.
    #[test]
    fn facing_yaw_is_none_when_aim_coincides() {
        let pos = Vec3::new(2.0, 0.6, -3.0);
        // Same XZ, different Y — still degenerate horizontally.
        let aim = Vec3::new(2.0, 0.0, -3.0);
        assert!(facing_yaw(pos, aim).is_none());
    }

    /// Movement is world-axis and decoupled from facing: forward intent (W = -Z)
    /// advances the player toward -Z regardless of where it is aiming.
    #[test]
    fn move_player_advances_world_axis_from_intent() {
        let mut app = App::new();
        app.add_plugins(MinimalPlugins);
        app.insert_resource(MoveIntent {
            dir: Vec3::new(0.0, 0.0, -1.0),
        });
        // Player aimed sideways (+X): movement must still go -Z (decoupled).
        let player = app
            .world_mut()
            .spawn((
                Player,
                Transform::from_xyz(0.0, 0.6, 0.0).with_rotation(Quat::from_rotation_y(
                    facing_yaw(Vec3::ZERO, Vec3::new(5.0, 0.0, 0.0)).unwrap(),
                )),
            ))
            .id();
        app.add_systems(Update, move_player);
        app.update();
        app.update();

        let z = app.world().get::<Transform>(player).unwrap().translation.z;
        assert!(z < 0.0, "forward intent should move toward -Z regardless of facing, got z={z}");
    }
}
