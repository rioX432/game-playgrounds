//! # s06 — Hide-and-seek prop disguise (prop-hunt)
//!
//! **What it demonstrates:** The "prop hunt" disguise mechanic, at parity with
//! the Three.js / Babylon.js `06` peers. A third-person player swaps its visible
//! mesh to one of a fixed catalog of environment props — crate / barrel / cone /
//! sphere — to blend in with **decoys of those same props** scattered around the
//! stage. The disguise has a "tell": MOVING breaks it. While still you are HIDDEN;
//! moving flips you to EXPOSED, shown by **easing** the player's color toward red
//! and **wobbling** the prop (so the tell is unmistakable), plus a HUD line.
//! Cycle the disguise with `Q`/`E`. Third-person on purpose — you must SEE your
//! own disguise to judge the blend, so a follow camera (from s01) is reused.
//!
//! **Controls:** `W/A/S/D` move (world axes; the prop turns to face travel). `Q`
//! previous disguise, `E` next (wraps both ways). `Esc` returns to the menu.
//!
//! **Feel notes:** Cycling disguises is instant and tactile — the mesh pops to
//! the next prop with zero delay. The HIDDEN ⇄ EXPOSED transition now **eases**
//! (red tint + wobble fade in over ~1/12 s) rather than snapping, so a brief twitch
//! reads as a flicker instead of a hard flip — much less punishing, closer to a
//! real "you moved" tell. Honest bad parts: (1) there is still **no real seeker
//! AI** — "blending in" is an honor-system judgment by the player against the
//! decoys, so the tension of a seeker sweeping the room is absent; this verifies
//! the disguise + tell *mechanic*, not the full loop. (2) The player still moves
//! collider-free (like s01), so you slide through the decoys rather than nestling
//! against them, which undercuts lining up with a prop.
//!
//! **Bevy 0.18 gotchas:**
//!   * Swapping the visible mesh overwrites the entity's `Mesh3d` component
//!     (re-insert it) — there is no `set_mesh`. The player keeps ONE owned
//!     `StandardMaterial`; the EXPOSED tint mutates that material's `base_color`
//!     each frame (`ResMut<Assets<StandardMaterial>>` + `get_mut`), so it never
//!     tints the shared decoys.
//!   * The disguise CATALOG (mesh/material handles) is held on the player entity,
//!     NOT a `Resource`: `DespawnOnExit` does not clear resources, so a catalog in
//!     a resource would survive the sample switch and leak GPU assets. On the
//!     player, handles drop when it despawns and the assets are freed.
//!   * Disguise cycling is edge-triggered (`just_pressed`, not `pressed`).
//!   * Index wrap uses `rem_euclid` so stepping back from 0 lands on the last entry.
//!   * Wobble phase uses `time.elapsed_secs()`; the eased exposure uses
//!     `time.delta_secs()`. `Query::single_mut()` returns `Result`.
//!
//! **Shared input:** movement reads the global [`MoveIntent`] resource. Disguise
//! cycling reads `ButtonInput<KeyCode>` directly (a one-off edge).
//!
//! **Shared HUD/scene:** ground + light come from `engine::scene`; the controls
//! overlay + FPS counter from `engine::hud` (all `DespawnOnExit`-scoped). The
//! player, follow camera, decoys, and disguise-state HUD line are spawned inline.

use bevy::prelude::*;

use crate::engine::hud;
use crate::engine::input::MoveIntent;
use crate::engine::scene;

use super::{AppState, SampleMeta};

pub const META: SampleMeta = SampleMeta {
    id: "06-hide-and-seek-disguise",
    title: "Hide-and-seek prop disguise",
    summary: "Swap your mesh to a prop to blend in; moving breaks the disguise (HIDDEN/EXPOSED).",
    tags: &["disguise", "prop-hunt", "stealth", "movement"],
};

/// Player movement speed in world units / second (matches the TS peers).
const MOVE_SPEED: f32 = 5.0;
/// Camera offset behind/above the player (world units).
const CAMERA_OFFSET: Vec3 = Vec3::new(0.0, 6.0, 10.0);
/// Speed (world units / second) above which the disguise is broken (EXPOSED).
/// Matches the TS peers; absorbs float jitter so a still player is never EXPOSED.
const EXPOSE_SPEED_THRESHOLD: f32 = 0.2;
/// Red tint the disguise color eases toward while EXPOSED (web peers' `0xff3b30`).
const EXPOSED_TINT: Srgba = Srgba::new(1.0, 0.231, 0.188, 1.0);
/// How fast the exposure (tint + wobble) eases in/out, per second.
const TINT_LERP_RATE: f32 = 12.0;
/// Wobble jitter frequency (rad/s) applied to the prop while EXPOSED.
const WOBBLE_FREQUENCY: f32 = 14.0;
/// Wobble tilt amplitude (radians) at full exposure.
const WOBBLE_AMPLITUDE: f32 = 0.12;
/// Secondary-axis (pitch) wobble tilt relative to the main (roll) wobble.
const WOBBLE_PITCH_RATIO: f32 = 0.5;

/// Scattered decoy positions (x, z), cycling through the prop catalog. Mirrors
/// the TS peers' `DECOY_POSITIONS` (−Z is in front of the start, same handedness).
const DECOY_POSITIONS: [(f32, f32); 8] = [
    (-6.0, -2.0),
    (-3.0, -8.0),
    (3.0, -6.0),
    (7.0, -1.0),
    (-8.0, -7.0),
    (5.0, -10.0),
    (0.0, -4.0),
    (-4.0, -12.0),
];

/// Marks the follow camera.
#[derive(Component)]
struct FollowCamera;

/// The player entity. Owns the disguise catalog + its single tintable material,
/// the selected index, the eased exposure (0 hidden → 1 exposed), the facing yaw,
/// and the previous-frame translation used to derive speed for the tell. Holding
/// the handles HERE (not a `Resource`) frees the assets on exit — see gotchas.
#[derive(Component)]
struct Player {
    /// Catalog of selectable disguises.
    catalog: Vec<DisguiseEntry>,
    /// Index into [`Self::catalog`] of the currently worn disguise.
    current: usize,
    /// The player's OWN material (tinted toward red by exposure each frame).
    material: Handle<StandardMaterial>,
    /// Eased exposure: 0 = fully hidden, 1 = fully exposed.
    exposure: f32,
    /// Facing yaw (radians), updated to the travel direction while moving.
    facing_yaw: f32,
    /// Player translation last frame, to derive per-frame speed for the tell.
    prev_translation: Vec3,
}

/// One catalog disguise: a prop mesh, its blend-in base color (the player's
/// material eases between this and red), the decoys' shared material, and the Y
/// offset that rests the prop on the ground (its half-height).
struct DisguiseEntry {
    label: &'static str,
    mesh: Handle<Mesh>,
    base_color: Srgba,
    decoy_material: Handle<StandardMaterial>,
    rest_y: f32,
}

pub struct HideAndSeekPlugin;

impl Plugin for HideAndSeekPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(OnEnter(AppState::S06HideAndSeek), setup)
            .add_systems(
                Update,
                (move_player, cycle_disguise, update_tell, follow_camera)
                    .chain()
                    .run_if(in_state(AppState::S06HideAndSeek)),
            );
    }
}

fn setup(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    let state = AppState::S06HideAndSeek;
    let scope = DespawnOnExit(state);

    // Shared scene primitives: ground + light. Each DespawnOnExit-scoped.
    scene::spawn_ground(&mut commands, &mut meshes, &mut materials, state);
    scene::spawn_light_preset(&mut commands, state);

    // Build the catalog ONCE (handles ref-counted; the clones on the player +
    // decoys keep the assets alive until those entities despawn on exit).
    let catalog = build_catalog(&mut meshes, &mut materials);

    // Scatter decoys: one per position, cycling through the prop catalog, so the
    // player has matching scenery to blend into (not generic boxes).
    for (i, (x, z)) in DECOY_POSITIONS.iter().enumerate() {
        let prop = &catalog[i % catalog.len()];
        commands.spawn((
            Mesh3d(prop.mesh.clone()),
            MeshMaterial3d(prop.decoy_material.clone()),
            Transform::from_xyz(*x, prop.rest_y, *z),
            scope.clone(),
        ));
    }

    // The player wears the first disguise via its OWN material (so the tint never
    // touches the shared decoys), resting on the ground at the prop's half-height.
    // Copy the entry-0 values out before moving `catalog` into the Player.
    let first_mesh = catalog[0].mesh.clone();
    let first_color = catalog[0].base_color;
    let first_rest_y = catalog[0].rest_y;
    let player_material = materials.add(StandardMaterial {
        base_color: first_color.into(),
        ..default()
    });
    let start = Vec3::new(0.0, first_rest_y, 10.0);
    commands.spawn((
        Player {
            material: player_material.clone(),
            catalog,
            current: 0,
            exposure: 0.0,
            facing_yaw: 0.0,
            prev_translation: start,
        },
        Mesh3d(first_mesh),
        MeshMaterial3d(player_material),
        Transform::from_translation(start),
        scope.clone(),
    ));

    // Follow camera (sample-specific), starting at the player's offset.
    commands.spawn((
        FollowCamera,
        Camera3d::default(),
        Transform::from_translation(start + CAMERA_OFFSET).looking_at(start, Vec3::Y),
        scope.clone(),
    ));

    // Disguise + state HUD line (sample-specific), updated every frame.
    commands.spawn((
        DisguiseHudText,
        scope,
        Text::new(""),
        TextFont {
            font_size: 18.0,
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
            "WASD — move (breaks disguise!)",
            "Q / E — cycle disguise",
            "Esc — back to menu",
        ],
    );
    hud::spawn_fps_counter(&mut commands, state);
}

/// Marker for the HUD line showing the current disguise + HIDDEN/EXPOSED state.
#[derive(Component)]
struct DisguiseHudText;

/// Builds the fixed disguise catalog (sizes/colors mirror the TS peers so the
/// player and the decoys are the same props). Pulled out so [`setup`] reads
/// cleanly and the count is asserted by a headless test.
fn build_catalog(
    meshes: &mut Assets<Mesh>,
    materials: &mut Assets<StandardMaterial>,
) -> Vec<DisguiseEntry> {
    let mut make = |label, mesh: Mesh, color: Srgba, rest_y| DisguiseEntry {
        label,
        mesh: meshes.add(mesh),
        base_color: color,
        decoy_material: materials.add(StandardMaterial {
            base_color: color.into(),
            ..default()
        }),
        rest_y,
    };
    vec![
        make("Crate", Cuboid::new(1.4, 1.4, 1.4).into(), Srgba::new(0.612, 0.420, 0.247, 1.0), 0.7),
        make("Barrel", Cylinder::new(0.7, 1.5).into(), Srgba::new(0.290, 0.471, 0.659, 1.0), 0.75),
        make(
            "Cone",
            Cone { radius: 0.85, height: 1.7 }.into(),
            Srgba::new(0.373, 0.682, 0.373, 1.0),
            0.85,
        ),
        make("Sphere", Sphere::new(0.8).into(), Srgba::new(0.690, 0.373, 0.682, 1.0), 0.8),
    ]
}

/// Moves the player on the XZ plane from the shared [`MoveIntent`] (world axes,
/// W = -Z) and, while moving, updates the facing yaw to the travel direction so
/// the prop turns to face where it walks (mirrors the TS peers).
fn move_player(
    time: Res<Time>,
    intent: Res<MoveIntent>,
    mut query: Query<(&mut Transform, &mut Player)>,
) {
    let Ok((mut transform, mut player)) = query.single_mut() else {
        return;
    };
    if intent.dir != Vec3::ZERO {
        transform.translation += intent.dir * MOVE_SPEED * time.delta_secs();
        player.facing_yaw = intent.dir.x.atan2(intent.dir.z);
    }
}

/// Edge-triggered disguise cycling: `Q` back, `E` forward (wraps via
/// [`cycle_index`]). Re-inserts the player's `Mesh3d` and rests it on the ground
/// at the new prop's half-height. The tint material is unchanged here — [`update_tell`]
/// recolors the player's own material from the new disguise's base color next frame.
fn cycle_disguise(
    keyboard: Res<ButtonInput<KeyCode>>,
    mut commands: Commands,
    mut query: Query<(Entity, &mut Player, &mut Transform)>,
) {
    let Ok((entity, mut player, mut transform)) = query.single_mut() else {
        return;
    };
    let mut delta = 0i32;
    if keyboard.just_pressed(KeyCode::KeyE) {
        delta += 1;
    }
    if keyboard.just_pressed(KeyCode::KeyQ) {
        delta -= 1;
    }
    if delta == 0 {
        return;
    }

    let len = player.catalog.len();
    player.current = cycle_index(player.current, delta, len);
    let entry = &player.catalog[player.current];
    transform.translation.y = entry.rest_y;
    let mesh = entry.mesh.clone();
    commands.entity(entity).insert(Mesh3d(mesh));
}

/// Recomputes the "tell" every frame: derive speed from the per-frame translation
/// delta, ease `exposure` toward 1 (moving) or 0 (still), tint the player's OWN
/// material from the disguise base color toward red by that exposure, wobble the
/// prop, and update the HUD line.
fn update_tell(
    time: Res<Time>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut player_q: Query<(&mut Player, &mut Transform)>,
    mut hud_q: Query<&mut Text, With<DisguiseHudText>>,
) {
    let Ok((mut player, mut transform)) = player_q.single_mut() else {
        return;
    };

    let dt = time.delta_secs();
    let distance = transform.translation.distance(player.prev_translation);
    let speed = if dt > 0.0 { distance / dt } else { 0.0 };
    player.prev_translation = transform.translation;

    let exposed_now = is_exposed(speed, EXPOSE_SPEED_THRESHOLD);
    let target = if exposed_now { 1.0 } else { 0.0 };
    player.exposure = ease_exposure(player.exposure, target, TINT_LERP_RATE, dt);

    // Tint: lerp the disguise base color toward red by the eased exposure.
    let base = player.catalog[player.current].base_color;
    if let Some(material) = materials.get_mut(&player.material) {
        material.base_color = lerp_srgba(base, EXPOSED_TINT, player.exposure).into();
    }

    // Wobble: tilt the prop (roll + a little pitch) while exposed; compose with
    // the facing yaw so a moving prop both points and jitters.
    let wobble = (time.elapsed_secs() * WOBBLE_FREQUENCY).sin() * WOBBLE_AMPLITUDE * player.exposure;
    transform.rotation = Quat::from_rotation_y(player.facing_yaw)
        * Quat::from_rotation_z(wobble)
        * Quat::from_rotation_x(wobble * WOBBLE_PITCH_RATIO);

    if let Ok(mut text) = hud_q.single_mut() {
        let label = player.catalog[player.current].label;
        let state = if exposed_now { "EXPOSED" } else { "HIDDEN" };
        **text = format!("Disguise: {label}  |  {state}");
    }
}

/// Hard-offset follow camera (no smoothing — matches s01's feel notes).
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

/// Pure helper: the disguise is broken (EXPOSED) when speed exceeds the tolerance
/// threshold. A still player stays HIDDEN. Extracted so the tell is testable.
fn is_exposed(speed: f32, threshold: f32) -> bool {
    speed > threshold
}

/// Pure helper: frame-rate-aware exponential ease of `current` toward `target` at
/// `rate` per second, clamping the blend to `1.0` so a large `dt` can't overshoot.
fn ease_exposure(current: f32, target: f32, rate: f32, dt: f32) -> f32 {
    current + (target - current) * (rate * dt).min(1.0)
}

/// Pure helper: per-channel linear interpolation between two colors (alpha kept
/// from `a`). Extracted so the tint blend is unit-testable.
fn lerp_srgba(a: Srgba, b: Srgba, t: f32) -> Srgba {
    Srgba::new(
        a.red + (b.red - a.red) * t,
        a.green + (b.green - a.green) * t,
        a.blue + (b.blue - a.blue) * t,
        a.alpha,
    )
}

/// Pure helper: steps a catalog index by `delta` and wraps both ways via
/// `rem_euclid` (stepping back from 0 lands on the last entry). `len == 0`
/// returns 0 defensively.
fn cycle_index(current: usize, delta: i32, len: usize) -> usize {
    if len == 0 {
        return 0;
    }
    let next = (current as i32 + delta).rem_euclid(len as i32);
    next as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The tell: a still player (speed at/below the threshold) is HIDDEN; moving
    /// past it is EXPOSED, with the threshold inclusive of "still".
    #[test]
    fn is_exposed_only_when_moving() {
        let threshold = EXPOSE_SPEED_THRESHOLD;
        assert!(!is_exposed(0.0, threshold), "perfectly still must be HIDDEN");
        assert!(
            !is_exposed(threshold, threshold),
            "speed exactly at the threshold must stay HIDDEN (jitter tolerance)"
        );
        assert!(is_exposed(MOVE_SPEED, threshold), "moving must be EXPOSED");
    }

    /// Exposure eases toward its target and never overshoots, even with a large
    /// `dt` (the blend clamps at 1.0). Non-tautological: checks partial progress
    /// on a normal step and exact arrival (no overshoot) on a huge step.
    #[test]
    fn ease_exposure_approaches_target_without_overshoot() {
        // Normal step: moves partway from 0 toward 1.
        let mid = ease_exposure(0.0, 1.0, TINT_LERP_RATE, 1.0 / 60.0);
        assert!(mid > 0.0 && mid < 1.0, "should ease partway, got {mid}");
        // Huge dt: blend clamps at 1.0, so it snaps to (but not past) the target.
        let snapped = ease_exposure(0.0, 1.0, TINT_LERP_RATE, 10.0);
        assert!((snapped - 1.0).abs() < 1e-6, "must not overshoot, got {snapped}");
        // Easing back down toward 0 also progresses.
        let down = ease_exposure(1.0, 0.0, TINT_LERP_RATE, 1.0 / 60.0);
        assert!(down < 1.0 && down > 0.0, "should ease back down, got {down}");
    }

    /// The tint blend interpolates each channel and is the endpoints at t=0/1.
    #[test]
    fn lerp_srgba_blends_channels() {
        let base = Srgba::new(0.6, 0.4, 0.2, 1.0);
        assert_eq!(lerp_srgba(base, EXPOSED_TINT, 0.0).red, base.red);
        assert_eq!(lerp_srgba(base, EXPOSED_TINT, 1.0).red, EXPOSED_TINT.red);
        let mid = lerp_srgba(base, EXPOSED_TINT, 0.5);
        assert!(
            mid.red > base.red && mid.red < EXPOSED_TINT.red,
            "mid red should be between endpoints, got {}",
            mid.red
        );
    }

    /// Index cycling wraps forward AND backward via `rem_euclid`.
    #[test]
    fn cycle_index_wraps_both_ways() {
        let len = 4; // crate / barrel / cone / sphere
        assert_eq!(cycle_index(0, 1, len), 1);
        assert_eq!(cycle_index(len - 1, 1, len), 0);
        assert_eq!(cycle_index(0, -1, len), len - 1);
        assert_eq!(cycle_index(2, -1, len), 1);
        assert_eq!(cycle_index(0, -1, 0), 0);
    }
}
