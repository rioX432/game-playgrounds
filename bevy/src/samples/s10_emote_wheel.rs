//! # s10 — Emote / pose radial wheel
//!
//! **What it demonstrates:** Hold a key (`Q`) to open a radial emote wheel; move
//! the mouse to aim a selection vector; the nearest sector highlights (with a
//! center dead-zone that selects nothing); releasing `Q` snaps to the highlighted
//! sector and plays that emote/pose on a multi-part primitive character. Ten
//! emotes are laid out in a circle as absolutely-positioned UI labels around
//! screen center. Poses are procedural Transform animations on the rig's child
//! parts (no skeletal art): WAVE oscillates an arm, JUMP hops the root, SPIN spins
//! the yaw, CROUCH lowers + squashes, SIT lowers + tilts, etc. A pose plays for a
//! fixed duration then returns to idle.
//!
//! **Controls:** Hold `Q` to open the wheel, move the mouse to aim, release `Q`
//! to emote. `W/A/S/D` move the character. `Esc` returns to the menu.
//!
//! **Feel notes:** Aiming with relative mouse motion (pointer-lock, no absolute
//! cursor) feels surprisingly natural for a radial — you flick toward the sector
//! and it lights up — but it has two honest rough edges. (1) The selection vector
//! accumulates raw mouse delta, so on a high-DPI mouse one small flick can shoot
//! straight past the dead-zone to full deflection; the gain is hand-tuned and
//! will feel different per mouse. (2) This sample's follow camera is a fixed hard
//! offset (it does NOT read mouse-look), so the wheel's mouse aim never fights the
//! view — but movement is suppressed while the wheel is open so you can't walk and
//! aim at once. The world effectively freezes under you for that beat; a real game
//! would dim/slow the scene to sell the pause. In a sample with a mouse-look
//! camera you'd additionally have to skip applying `LookState` to the camera while
//! the wheel is open, or the aim would also swing the view. The poses themselves
//! are procedural and read as
//! "blocky mime" rather than real animation: WAVE is a single arm hinge, SPIN can
//! look like the character is glitching rather than dancing. Honest cost of
//! primitives-only art. Snap-on-release feels crisp; the dead-zone cancel (release
//! while centered = no emote) is essential so a stray click doesn't fire a random
//! emote.
//!
//! **Bevy 0.18 gotchas:**
//!   * UI is `Node` + `Text::new(..)` + `TextFont`/`TextColor`/`BackgroundColor`
//!     — no `NodeBundle`/`TextBundle`/`Style`. Absolute placement via `Node`'s
//!     `position_type`/`left`/`top`. We compute each label's `left`/`top` from its
//!     sector angle + a pixel radius around an assumed screen center.
//!   * Rig parts are parented with `with_children`; child `Transform`s are LOCAL
//!     to the root, so poses animate children relative to the body and the whole
//!     rig still moves/rotates as one.
//!   * Scoped cleanup is `DespawnOnExit(state)` (0.18), NOT `StateScoped`. The
//!     wheel UI is spawned once in `setup` and toggled via `Node.display`, but it
//!     is `DespawnOnExit`-scoped so leaving the sample despawns it too.
//!   * Per-frame mouse aim reads `LookState.delta` from the shared input module;
//!     `Time` delta is `time.delta_secs()` (f32).

use std::f32::consts::TAU;

use bevy::prelude::*;

use crate::engine::hud;
use crate::engine::input::LookState;
use crate::engine::input::MoveIntent;
use crate::engine::scene;

use super::{AppState, SampleMeta};

pub const META: SampleMeta = SampleMeta {
    id: "10-emote-wheel",
    title: "Emote / pose radial wheel",
    summary: "Hold Q to open a radial emote wheel, aim with the mouse, release to play a pose.",
    tags: &["ui", "radial-menu", "emote", "pose", "input"],
};

/// Player movement speed (world units / second).
const MOVE_SPEED: f32 = 5.0;
/// Camera offset behind/above the player.
const CAMERA_OFFSET: Vec3 = Vec3::new(0.0, 5.0, 9.0);

/// Mouse-aim gain: pixels of accumulated delta scaled into the selection vector.
const AIM_GAIN: f32 = 0.02;
/// Maximum length of the selection vector (so it saturates instead of growing
/// unbounded while the wheel is held and the mouse keeps moving).
const SELECTION_MAX_LEN: f32 = 1.5;
/// Dead-zone radius: a selection vector shorter than this selects no sector.
const DEAD_ZONE: f32 = 0.35;

/// Number of emote sectors in the wheel.
const NUM_SECTORS: usize = 10;
/// Pixel radius of the wheel labels from the (assumed) screen center.
const WHEEL_RADIUS_PX: f32 = 180.0;
/// Assumed screen center in pixels (matches the default window; the wheel is a
/// fixed-position overlay, so this is an intentional simplification — see feel
/// notes / gotchas).
const SCREEN_CENTER_X: f32 = 640.0;
const SCREEN_CENTER_Y: f32 = 360.0;

/// How long a triggered pose plays before returning to idle (seconds).
const POSE_DURATION: f32 = 1.6;

/// The ten emotes/poses, in wheel order (sector 0 = pointing right / +X screen,
/// increasing counter-clockwise to match screen-space angle math).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Emote {
    Wave,
    Jump,
    Spin,
    Crouch,
    Sit,
    Cheer,
    Point,
    Nod,
    Shrug,
    Dance,
}

impl Emote {
    /// All emotes in wheel order. Index = sector index.
    const ALL: [Emote; NUM_SECTORS] = [
        Emote::Wave,
        Emote::Jump,
        Emote::Spin,
        Emote::Crouch,
        Emote::Sit,
        Emote::Cheer,
        Emote::Point,
        Emote::Nod,
        Emote::Shrug,
        Emote::Dance,
    ];

    /// Short label shown in the wheel + HUD.
    fn label(self) -> &'static str {
        match self {
            Emote::Wave => "Wave",
            Emote::Jump => "Jump",
            Emote::Spin => "Spin",
            Emote::Crouch => "Crouch",
            Emote::Sit => "Sit",
            Emote::Cheer => "Cheer",
            Emote::Point => "Point",
            Emote::Nod => "Nod",
            Emote::Shrug => "Shrug",
            Emote::Dance => "Dance",
        }
    }
}

/// Pure helper: maps a 2D selection vector to a sector index, or `None` inside the
/// dead-zone. Sector 0 is centered on +X (angle 0); sectors increase
/// counter-clockwise. Wraps correctly at ±π. Each sector spans `TAU / count`.
///
/// Extracted so headless tests can assert the angle→index mapping without a
/// window or any ECS.
fn sector_for(selection: Vec2, count: usize, dead_zone: f32) -> Option<usize> {
    if count == 0 || selection.length() < dead_zone {
        return None;
    }
    let sector_span = TAU / count as f32;
    // atan2 in (-PI, PI]; shift into [0, TAU) then bias by half a sector so the
    // sector is *centered* on its representative angle (sector 0 spans
    // [-span/2, +span/2)).
    let mut angle = selection.y.atan2(selection.x);
    if angle < 0.0 {
        angle += TAU;
    }
    let idx = ((angle + sector_span * 0.5) / sector_span).floor() as usize % count;
    Some(idx)
}

/// Pure helper: screen-pixel position of sector `idx`'s label, given the wheel
/// center, pixel radius, and sector count. Mirrors `sector_for`'s angle
/// convention (sector 0 at +X, counter-clockwise) but flips Y because screen
/// space grows downward. Returns the label's top-left offset.
fn sector_label_pos(idx: usize, count: usize, center: Vec2, radius: f32) -> Vec2 {
    let sector_span = TAU / count.max(1) as f32;
    let angle = sector_span * idx as f32;
    // Screen Y grows downward, so negate the sin term to keep the wheel visually
    // matching the selection-vector convention used by `sector_for`.
    Vec2::new(
        center.x + radius * angle.cos(),
        center.y - radius * angle.sin(),
    )
}

/// Per-sample wheel + pose state. Reset to default in `setup` (`OnEnter`).
#[derive(Resource, Debug, Clone, Copy)]
struct WheelState {
    /// Whether the wheel is currently open (key held).
    open: bool,
    /// Accumulated mouse-aim selection vector while the wheel is open.
    selection: Vec2,
    /// Currently highlighted sector (None inside the dead-zone).
    highlighted: Option<usize>,
    /// The emote currently playing (None = idle).
    active: Option<Emote>,
    /// Elapsed time of the active pose (seconds).
    elapsed: f32,
}

impl Default for WheelState {
    fn default() -> Self {
        Self {
            open: false,
            selection: Vec2::ZERO,
            highlighted: None,
            active: None,
            elapsed: 0.0,
        }
    }
}

#[derive(Component)]
struct Player;

#[derive(Component)]
struct FollowCamera;

/// Marker for the rig root (the moving body). Poses animate it + its children.
#[derive(Component)]
struct RigRoot;

/// Which child part of the rig an entity is. Tags the head + two arms so a single
/// `Query<(&RigPart, &mut Transform)>` can reset + animate them all (avoids four
/// disjoint `Without<..>` queries / `type_complexity`).
#[derive(Component, Debug, Clone, Copy, PartialEq, Eq)]
enum RigPart {
    Head,
    LeftArm,
    RightArm,
}

/// Marker on the root UI node of the wheel overlay (toggled via `Node.display`).
#[derive(Component)]
struct WheelUi;

/// Marker on each sector label, carrying its sector index for highlighting.
#[derive(Component)]
struct SectorLabel(usize);

/// Marker on the HUD line that shows the current emote.
#[derive(Component)]
struct EmoteStatusText;

/// The key that opens the wheel while held.
const WHEEL_KEY: KeyCode = KeyCode::KeyQ;

pub struct EmoteWheelPlugin;

impl Plugin for EmoteWheelPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(OnEnter(AppState::S10EmoteWheel), setup).add_systems(
            Update,
            (
                update_wheel,
                move_player,
                animate_pose,
                follow_camera,
                update_wheel_ui,
            )
                .chain()
                .run_if(in_state(AppState::S10EmoteWheel)),
        );
    }
}

fn setup(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    let state = AppState::S10EmoteWheel;
    let scope = DespawnOnExit(state);

    // Reset per-sample state so re-entering the sample starts clean (no drift).
    commands.insert_resource(WheelState::default());

    // Shared scene: ground + light. No box grid (the wheel + rig are the focus).
    scene::spawn_ground(&mut commands, &mut meshes, &mut materials, state);
    scene::spawn_light_preset(&mut commands, state);

    // Multi-part primitive rig: root (body) + head + two arms, so procedural
    // poses have parts to animate. Children Transforms are LOCAL to the root.
    let body_material = materials.add(StandardMaterial {
        base_color: Color::srgb(0.2, 0.5, 0.9),
        ..default()
    });
    let skin_material = materials.add(StandardMaterial {
        base_color: Color::srgb(0.95, 0.85, 0.7),
        ..default()
    });
    let arm_mesh = meshes.add(Cuboid::new(0.25, 1.0, 0.25));

    commands
        .spawn((
            Player,
            RigRoot,
            Mesh3d(meshes.add(Capsule3d::new(0.5, 1.0))),
            MeshMaterial3d(body_material.clone()),
            Transform::from_xyz(0.0, 1.0, 0.0),
            Visibility::default(),
            scope.clone(),
        ))
        .with_children(|parent| {
            // Head.
            parent.spawn((
                RigPart::Head,
                Mesh3d(meshes.add(Sphere::new(0.4))),
                MeshMaterial3d(skin_material.clone()),
                Transform::from_xyz(0.0, 1.1, 0.0),
            ));
            // Left arm: the child's own Transform is the shoulder hinge.
            parent.spawn((
                RigPart::LeftArm,
                Mesh3d(arm_mesh.clone()),
                MeshMaterial3d(body_material.clone()),
                Transform::from_xyz(-0.65, 0.2, 0.0),
            ));
            // Right arm.
            parent.spawn((
                RigPart::RightArm,
                Mesh3d(arm_mesh.clone()),
                MeshMaterial3d(body_material.clone()),
                Transform::from_xyz(0.65, 0.2, 0.0),
            ));
        });

    // Follow camera.
    commands.spawn((
        FollowCamera,
        Camera3d::default(),
        Transform::from_translation(CAMERA_OFFSET).looking_at(Vec3::ZERO, Vec3::Y),
        scope.clone(),
    ));

    // Wheel UI: a full-screen overlay (hidden by default) holding the ten sector
    // labels positioned in a circle, plus a center dead-zone dot. Spawned ONCE
    // and toggled via `Node.display`; `DespawnOnExit`-scoped so it cleans up.
    let center = Vec2::new(SCREEN_CENTER_X, SCREEN_CENTER_Y);
    commands
        .spawn((
            WheelUi,
            Node {
                position_type: PositionType::Absolute,
                width: Val::Percent(100.0),
                height: Val::Percent(100.0),
                // Hidden until the wheel opens.
                display: Display::None,
                ..default()
            },
            scope.clone(),
        ))
        .with_children(|parent| {
            // Center dead-zone dot.
            parent.spawn((
                Node {
                    position_type: PositionType::Absolute,
                    left: Val::Px(center.x - 4.0),
                    top: Val::Px(center.y - 4.0),
                    width: Val::Px(8.0),
                    height: Val::Px(8.0),
                    ..default()
                },
                BackgroundColor(Color::srgb(0.6, 0.6, 0.6)),
            ));
            // Sector labels.
            for (idx, emote) in Emote::ALL.iter().enumerate() {
                let pos = sector_label_pos(idx, NUM_SECTORS, center, WHEEL_RADIUS_PX);
                parent.spawn((
                    SectorLabel(idx),
                    Node {
                        position_type: PositionType::Absolute,
                        left: Val::Px(pos.x - 28.0),
                        top: Val::Px(pos.y - 10.0),
                        padding: UiRect::all(Val::Px(4.0)),
                        ..default()
                    },
                    BackgroundColor(SECTOR_IDLE_BG),
                    Text::new(emote.label()),
                    TextFont {
                        font_size: 14.0,
                        ..default()
                    },
                    TextColor(Color::srgb(0.9, 0.9, 0.95)),
                ));
            }
        });

    // HUD: controls + current-emote status line.
    hud::spawn_controls_overlay(
        &mut commands,
        state,
        &[
            "Hold Q — open emote wheel",
            "Move mouse — aim sector",
            "Release Q — play emote",
            "WASD — move",
            "Esc — back to menu",
        ],
    );
    hud::spawn_fps_counter(&mut commands, state);

    // Current-emote status line (top-left, above the controls overlay).
    commands.spawn((
        EmoteStatusText,
        Text::new("Emote: idle"),
        TextFont {
            font_size: 16.0,
            ..default()
        },
        TextColor(Color::srgb(0.95, 0.85, 0.4)),
        Node {
            position_type: PositionType::Absolute,
            top: Val::Px(8.0),
            left: Val::Px(8.0),
            ..default()
        },
        scope,
    ));
}

/// Idle / highlighted sector background colors.
const SECTOR_IDLE_BG: Color = Color::srgba(0.1, 0.1, 0.15, 0.7);
const SECTOR_HILITE_BG: Color = Color::srgb(0.95, 0.6, 0.15);

/// Drives the wheel state machine: open on key-hold (resetting the selection),
/// accumulate mouse-aim while open, compute the highlighted sector, and on
/// release snap to the highlight + start that emote (dead-zone cancels).
fn update_wheel(
    keyboard: Res<ButtonInput<KeyCode>>,
    look: Res<LookState>,
    mut wheel: ResMut<WheelState>,
) {
    // Opening edge: reset the selection vector to center so aim starts fresh.
    if keyboard.just_pressed(WHEEL_KEY) {
        wheel.open = true;
        wheel.selection = Vec2::ZERO;
        wheel.highlighted = None;
    }

    if wheel.open {
        // Accumulate mouse delta into the selection vector. Screen Y grows down,
        // so negate delta.y to match the selection-vector convention (up = +Y).
        wheel.selection += Vec2::new(look.delta.x, -look.delta.y) * AIM_GAIN;
        let len = wheel.selection.length();
        if len > SELECTION_MAX_LEN {
            wheel.selection = wheel.selection / len * SELECTION_MAX_LEN;
        }
        wheel.highlighted = sector_for(wheel.selection, NUM_SECTORS, DEAD_ZONE);
    }

    // Releasing edge: snap to the highlighted sector and play that emote. Inside
    // the dead-zone (`highlighted == None`) this cancels with no emote.
    if keyboard.just_released(WHEEL_KEY) && wheel.open {
        wheel.open = false;
        if let Some(idx) = wheel.highlighted {
            wheel.active = Some(Emote::ALL[idx]);
            wheel.elapsed = 0.0;
        }
        wheel.highlighted = None;
        wheel.selection = Vec2::ZERO;
    }
}

/// Moves the player from the shared [`MoveIntent`]. Movement is disabled while the
/// wheel is open so aiming doesn't also walk the character.
fn move_player(
    time: Res<Time>,
    intent: Res<MoveIntent>,
    wheel: Res<WheelState>,
    mut query: Query<&mut Transform, With<Player>>,
) {
    if wheel.open {
        return;
    }
    let Ok(mut transform) = query.single_mut() else {
        return;
    };
    if intent.dir != Vec3::ZERO {
        transform.translation += intent.dir * MOVE_SPEED * time.delta_secs();
    }
}

/// Advances the active pose timer and applies the pose as a procedural Transform
/// animation, RESETTING each part to its rest pose first so poses never drift or
/// accumulate. When the timer passes [`POSE_DURATION`] the emote ends and the rig
/// returns to idle.
fn animate_pose(
    time: Res<Time>,
    mut wheel: ResMut<WheelState>,
    mut root: Query<&mut Transform, (With<RigRoot>, Without<RigPart>)>,
    mut parts: Query<(&RigPart, &mut Transform), Without<RigRoot>>,
) {
    let Ok(mut root_t) = root.single_mut() else {
        return;
    };

    // Resolve the three child parts. Missing any part aborts (rig not spawned).
    let (mut left_t, mut right_t, mut head_t) = (None, None, None);
    for (part, transform) in &mut parts {
        match part {
            RigPart::LeftArm => left_t = Some(transform),
            RigPart::RightArm => right_t = Some(transform),
            RigPart::Head => head_t = Some(transform),
        }
    }
    let (Some(mut left_t), Some(mut right_t), Some(mut head_t)) = (left_t, right_t, head_t) else {
        return;
    };

    // Rest pose (reset-then-apply: clear last frame's pose so nothing accumulates).
    // The root's translation X/Z is owned by `move_player`; only the pose-driven
    // Y/rotation/scale are reset here.
    root_t.translation.y = 1.0;
    root_t.rotation = Quat::IDENTITY;
    root_t.scale = Vec3::ONE;
    left_t.translation = Vec3::new(-0.65, 0.2, 0.0);
    left_t.rotation = Quat::IDENTITY;
    right_t.translation = Vec3::new(0.65, 0.2, 0.0);
    right_t.rotation = Quat::IDENTITY;
    head_t.translation = Vec3::new(0.0, 1.1, 0.0);
    head_t.rotation = Quat::IDENTITY;

    let Some(emote) = wheel.active else {
        return;
    };

    wheel.elapsed += time.delta_secs();
    if wheel.elapsed >= POSE_DURATION {
        wheel.active = None;
        wheel.elapsed = 0.0;
        return;
    }

    // Normalized progress [0,1) and a wobble phase for oscillating poses.
    let t = wheel.elapsed / POSE_DURATION;
    let phase = wheel.elapsed * 8.0;

    match emote {
        // Oscillate the right arm forward/back about the shoulder.
        Emote::Wave => {
            right_t.rotation = Quat::from_rotation_z(-1.0 + phase.sin() * 0.6);
        }
        // Hop the whole rig with a sine arc.
        Emote::Jump => {
            root_t.translation.y = 1.0 + (t * std::f32::consts::PI).sin() * 1.2;
        }
        // Spin the rig yaw a full turn over the duration.
        Emote::Spin => {
            root_t.rotation = Quat::from_rotation_y(t * TAU);
        }
        // Lower + squash the body.
        Emote::Crouch => {
            root_t.translation.y = 0.6;
            root_t.scale = Vec3::new(1.1, 0.6, 1.1);
        }
        // Lower + tilt back as if sitting.
        Emote::Sit => {
            root_t.translation.y = 0.5;
            root_t.rotation = Quat::from_rotation_x(-0.5);
        }
        // Both arms up, bouncing.
        Emote::Cheer => {
            let lift = -2.4 + phase.sin() * 0.3;
            left_t.rotation = Quat::from_rotation_z(-lift);
            right_t.rotation = Quat::from_rotation_z(lift);
            root_t.translation.y = 1.0 + phase.sin().abs() * 0.15;
        }
        // Hold the right arm straight out (point).
        Emote::Point => {
            right_t.rotation = Quat::from_rotation_z(-std::f32::consts::FRAC_PI_2);
        }
        // Nod the head up/down.
        Emote::Nod => {
            head_t.rotation = Quat::from_rotation_x(phase.sin() * 0.4);
        }
        // Both arms out + a small shoulder shrug bounce.
        Emote::Shrug => {
            left_t.rotation = Quat::from_rotation_z(0.6);
            right_t.rotation = Quat::from_rotation_z(-0.6);
            let bounce = phase.sin().abs() * 0.1;
            left_t.translation.y = 0.2 + bounce;
            right_t.translation.y = 0.2 + bounce;
        }
        // Sway the body + swing both arms (a simple dance).
        Emote::Dance => {
            root_t.rotation = Quat::from_rotation_z((phase * 0.5).sin() * 0.25);
            left_t.rotation = Quat::from_rotation_z(phase.sin() * 0.8);
            right_t.rotation = Quat::from_rotation_z(-phase.sin() * 0.8);
            root_t.translation.y = 1.0 + phase.sin().abs() * 0.1;
        }
    }
}

/// Hard-offset follow camera (no smoothing — matches s01's reference feel).
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

/// Syncs the wheel UI to [`WheelState`]: shows/hides the overlay, highlights the
/// selected sector label, and writes the current-emote status line.
fn update_wheel_ui(
    wheel: Res<WheelState>,
    mut ui: Query<&mut Node, With<WheelUi>>,
    mut labels: Query<(&SectorLabel, &mut BackgroundColor)>,
    mut status: Query<&mut Text, With<EmoteStatusText>>,
) {
    if let Ok(mut node) = ui.single_mut() {
        node.display = if wheel.open { Display::Flex } else { Display::None };
    }

    for (label, mut bg) in &mut labels {
        let selected = wheel.open && wheel.highlighted == Some(label.0);
        bg.0 = if selected { SECTOR_HILITE_BG } else { SECTOR_IDLE_BG };
    }

    if let Ok(mut text) = status.single_mut() {
        **text = match wheel.active {
            Some(emote) => format!("Emote: {}", emote.label()),
            None => "Emote: idle".to_string(),
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sector mapping: cardinal directions land on the expected sectors for a
    /// 10-sector wheel (sector 0 centered on +X, increasing counter-clockwise).
    #[test]
    fn sector_for_maps_cardinal_directions() {
        // +X -> sector 0 (centered there).
        assert_eq!(sector_for(Vec2::new(1.0, 0.0), 10, DEAD_ZONE), Some(0));
        // Straight up (+Y) is a quarter turn = sector 2.5 -> rounds to 2 or 3;
        // a hair toward +X biases it to sector 2.
        assert_eq!(sector_for(Vec2::new(0.3, 1.0), 10, DEAD_ZONE), Some(2));
        // -X is half a turn = sector 5.
        assert_eq!(sector_for(Vec2::new(-1.0, 0.0), 10, DEAD_ZONE), Some(5));
    }

    /// Wraparound at ±π: a vector just below the +X axis must fold back to the
    /// last sector (9), not overflow past it.
    #[test]
    fn sector_for_wraps_at_pi() {
        // Just below +X (small negative angle) is within sector 0's lower half.
        assert_eq!(sector_for(Vec2::new(1.0, -0.05), 10, DEAD_ZONE), Some(0));
        // Down-and-slightly-right (atan2 ~= -73 deg -> 287 deg) lands in sector 8.
        assert_eq!(sector_for(Vec2::new(0.3, -1.0), 10, DEAD_ZONE), Some(8));
        // The returned index is always in range.
        for i in 0..360 {
            let a = i as f32 * TAU / 360.0;
            let idx = sector_for(Vec2::new(a.cos(), a.sin()), 10, DEAD_ZONE).unwrap();
            assert!(idx < 10, "index {idx} out of range at angle {a}");
        }
    }

    /// Dead-zone: a vector shorter than the dead-zone radius selects no sector.
    #[test]
    fn sector_for_dead_zone_selects_none() {
        assert_eq!(sector_for(Vec2::ZERO, 10, DEAD_ZONE), None);
        assert_eq!(
            sector_for(Vec2::new(DEAD_ZONE * 0.5, 0.0), 10, DEAD_ZONE),
            None
        );
        // Just outside the dead-zone selects a sector again.
        assert!(sector_for(Vec2::new(DEAD_ZONE * 1.1, 0.0), 10, DEAD_ZONE).is_some());
    }

    /// Snap-on-release: holding the wheel, aiming past the dead-zone, then
    /// releasing sets `active` to the highlighted emote; releasing inside the
    /// dead-zone leaves it idle (cancel).
    #[test]
    fn release_snaps_to_highlight_and_dead_zone_cancels() {
        // Aim far in +X -> sector 0 (Wave).
        let mut wheel = WheelState {
            open: true,
            selection: Vec2::new(1.0, 0.0),
            highlighted: sector_for(Vec2::new(1.0, 0.0), NUM_SECTORS, DEAD_ZONE),
            active: None,
            elapsed: 0.0,
        };
        assert_eq!(wheel.highlighted, Some(0));
        // Simulate the release branch of `update_wheel`.
        if let Some(idx) = wheel.highlighted {
            wheel.active = Some(Emote::ALL[idx]);
        }
        assert_eq!(wheel.active, Some(Emote::Wave));

        // Dead-zone release: no highlight -> stays idle.
        let mut centered = WheelState {
            open: true,
            selection: Vec2::ZERO,
            highlighted: sector_for(Vec2::ZERO, NUM_SECTORS, DEAD_ZONE),
            active: None,
            elapsed: 0.0,
        };
        assert_eq!(centered.highlighted, None);
        if let Some(idx) = centered.highlighted {
            centered.active = Some(Emote::ALL[idx]);
        }
        assert_eq!(centered.active, None, "dead-zone release must not fire an emote");
    }

    /// Pose lifecycle: the active emote returns to idle once it has played for
    /// `POSE_DURATION`, and resets the elapsed timer.
    #[test]
    fn pose_returns_to_idle_after_duration() {
        let mut app = App::new();
        app.add_plugins(MinimalPlugins);
        app.insert_resource(WheelState {
            open: false,
            selection: Vec2::ZERO,
            highlighted: None,
            active: Some(Emote::Jump),
            elapsed: POSE_DURATION + 1.0, // already past the duration
        });
        // Spawn the rig parts the system queries.
        app.world_mut().spawn((RigRoot, Transform::from_xyz(0.0, 1.0, 0.0)));
        app.world_mut().spawn((RigPart::LeftArm, Transform::default()));
        app.world_mut().spawn((RigPart::RightArm, Transform::default()));
        app.world_mut().spawn((RigPart::Head, Transform::default()));
        app.add_systems(Update, animate_pose);
        app.update();

        let wheel = *app.world().resource::<WheelState>();
        assert_eq!(wheel.active, None, "pose past its duration must return to idle");
        assert_eq!(wheel.elapsed, 0.0, "elapsed resets when the pose ends");
    }
}
