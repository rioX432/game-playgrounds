//! # s13 — Stress / load harness (bevy_rapier3d)
//!
//! **What it demonstrates:** The cross-engine **performance probe** (sibling of
//! the `three/` and `babylon/` harnesses). Spawn batches of dynamic cuboids onto
//! a floor and watch the per-frame cost climb as the body count rises. A live HUD
//! shows `bodies: N | ms/frame: X (~FPS)`. This is the native (wgpu) data point
//! for the `WebGL < WebGPU < native` claim in COMPARISON §5.
//!
//! **Controls:** `Space` — add 100 boxes (up to a 2000 cap). `R` — clear all.
//! `Esc` — back to the menu.
//!
//! **Feel notes:** The point is the *ramp*, not a single frame — tap `Space` and
//! the `ms/frame` number climbs as the rapier solver + draw calls add up. Where it
//! crosses ~16.7 ms (60 FPS) on your machine is the honest headroom.
//!
//! **Measured numbers are now in COMPARISON §5.** Matched ms/frame across the
//! three engines (same body count, same machine — Apple Silicon Mac, 120 Hz) were
//! captured by running each build. Native Bevy stays pinned at the 120 Hz vsync
//! cap (8.3 ms) all the way to 2000 bodies where the web engines fall to 61-76 fps;
//! uncapped, Bevy renders + simulates 2000 bodies in ~6.3 ms (~160 fps). See §5
//! for the full table, method, and caveats.
//!
//! **Bevy 0.18 gotchas:**
//!   * Boxes share one `Mesh3d`/`MeshMaterial3d` handle (stored in a resource) so
//!     a batch spawn clones handles, not assets. They are NOT GPU-instanced, so at
//!     high counts draw cost shows alongside physics.
//!   * No `rand` dependency (deps stay `bevy` + `bevy_rapier3d` only): spawn
//!     positions use a cheap deterministic integer hash for scatter.
//!   * Frame time is an EMA of `time.delta_secs()` in a `Resource` reset on
//!     `OnEnter`; `DespawnOnExit` clears the bodies but not resources.

use bevy::prelude::*;
use bevy_rapier3d::prelude::*;

use crate::engine::hud;

use super::{AppState, SampleMeta};

pub const META: SampleMeta = SampleMeta {
    id: "13-stress-bodies",
    title: "Stress / Load Harness",
    summary: "Spawn batches of dynamic boxes and watch ms/frame climb (cross-engine perf probe).",
    tags: &["physics", "rapier", "performance", "stress"],
};

const BOX_HALF: f32 = 0.3;
const BATCH_SIZE: usize = 100;
const MAX_BODIES: usize = 2000;
const FLOOR_HALF: f32 = 12.0;
const SPAWN_HEIGHT: f32 = 10.0;
const SPAWN_SPREAD: f32 = 4.0;

/// Marks a spawned stress box (so `R` can clear them all).
#[derive(Component)]
struct StressBox;

/// Marks the HUD stats line.
#[derive(Component)]
struct StatsText;

/// Shared mesh + material handles for spawned boxes (clone-per-body, no realloc).
#[derive(Resource)]
struct StressAssets {
    mesh: Handle<Mesh>,
    material: Handle<StandardMaterial>,
}

/// Smoothed frame time (ms). A resource, reset on `OnEnter` (DespawnOnExit does
/// not touch resources).
#[derive(Resource, Default)]
struct FrameStats {
    ms_per_frame: f32,
}

pub struct StressBodiesPlugin;

impl Plugin for StressBodiesPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(OnEnter(AppState::S13StressBodies), setup).add_systems(
            Update,
            (handle_input, update_stats).run_if(in_state(AppState::S13StressBodies)),
        );
    }
}

fn setup(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    let state = AppState::S13StressBodies;
    let scope = DespawnOnExit(state);

    commands.insert_resource(FrameStats::default());
    let assets = StressAssets {
        mesh: meshes.add(Cuboid::new(BOX_HALF * 2.0, BOX_HALF * 2.0, BOX_HALF * 2.0)),
        material: materials.add(StandardMaterial {
            base_color: Color::srgb(1.0, 0.53, 0.27),
            ..default()
        }),
    };

    // Floor: render plane + a static cuboid collider to catch the boxes.
    commands.spawn((
        Mesh3d(meshes.add(Plane3d::default().mesh().size(FLOOR_HALF * 2.0, FLOOR_HALF * 2.0))),
        MeshMaterial3d(materials.add(StandardMaterial {
            base_color: Color::srgb(0.22, 0.22, 0.26),
            ..default()
        })),
        Transform::IDENTITY,
        RigidBody::Fixed,
        Collider::cuboid(FLOOR_HALF, 0.05, FLOOR_HALF),
        scope.clone(),
    ));

    commands.spawn((
        DirectionalLight {
            illuminance: 9_000.0,
            shadows_enabled: false, // shadows would dominate cost at high counts
            ..default()
        },
        Transform::from_xyz(6.0, 12.0, 6.0).looking_at(Vec3::ZERO, Vec3::Y),
        scope.clone(),
    ));

    commands.spawn((
        Camera3d::default(),
        Transform::from_xyz(0.0, 10.0, 20.0).looking_at(Vec3::new(0.0, 2.0, 0.0), Vec3::Y),
        scope.clone(),
    ));

    // Stats HUD line (top-left).
    commands.spawn((
        StatsText,
        scope.clone(),
        Text::new("bodies: 0"),
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
            "Space — add 100 boxes",
            "R — clear all",
            "Esc — back to menu",
        ],
    );

    // Seed one batch so something is happening on entry.
    spawn_batch(&mut commands, &assets, 0);
    commands.insert_resource(assets);
}

/// `Space` adds a batch (up to the cap); `R` clears all boxes.
fn handle_input(
    keyboard: Res<ButtonInput<KeyCode>>,
    mut commands: Commands,
    assets: Res<StressAssets>,
    boxes: Query<Entity, With<StressBox>>,
) {
    let count = boxes.iter().count();
    if keyboard.just_pressed(KeyCode::Space) {
        spawn_batch(&mut commands, &assets, count);
    }
    if keyboard.just_pressed(KeyCode::KeyR) {
        for entity in &boxes {
            commands.entity(entity).despawn();
        }
    }
}

/// Spawns up to [`BATCH_SIZE`] dynamic boxes (respecting [`MAX_BODIES`]) above the
/// floor, scattered by a cheap deterministic hash so no `rand` dependency is needed.
fn spawn_batch(commands: &mut Commands, assets: &StressAssets, existing: usize) {
    let room = MAX_BODIES.saturating_sub(existing);
    let n = room.min(BATCH_SIZE);
    for i in 0..n {
        let seed = (existing + i) as u32;
        let x = hash01(seed.wrapping_mul(3)) * SPAWN_SPREAD - SPAWN_SPREAD * 0.5;
        let z = hash01(seed.wrapping_mul(5)) * SPAWN_SPREAD - SPAWN_SPREAD * 0.5;
        let y = SPAWN_HEIGHT + hash01(seed.wrapping_mul(7)) * SPAWN_SPREAD;
        commands.spawn((
            StressBox,
            Mesh3d(assets.mesh.clone()),
            MeshMaterial3d(assets.material.clone()),
            Transform::from_xyz(x, y, z),
            RigidBody::Dynamic,
            Collider::cuboid(BOX_HALF, BOX_HALF, BOX_HALF),
            DespawnOnExit(AppState::S13StressBodies),
        ));
    }
}

/// Updates the EMA frame time and writes the `bodies / ms-per-frame / FPS` readout.
fn update_stats(
    time: Res<Time>,
    mut stats: ResMut<FrameStats>,
    boxes: Query<(), With<StressBox>>,
    mut text_q: Query<&mut Text, With<StatsText>>,
) {
    let dt_ms = time.delta_secs() * 1000.0;
    stats.ms_per_frame = if stats.ms_per_frame == 0.0 {
        dt_ms
    } else {
        stats.ms_per_frame * 0.9 + dt_ms * 0.1
    };
    let count = boxes.iter().count();
    let fps = if stats.ms_per_frame > 0.0 {
        1000.0 / stats.ms_per_frame
    } else {
        0.0
    };
    if let Ok(mut text) = text_q.single_mut() {
        **text = format!(
            "bodies: {count}  |  {:.1} ms/frame  (~{} FPS)",
            stats.ms_per_frame,
            fps.round() as i32
        );
    }
}

/// Cheap deterministic hash → `[0, 1)`. Avoids a `rand` dependency for scatter.
fn hash01(n: u32) -> f32 {
    let h = n.wrapping_mul(2_654_435_761);
    ((h >> 8) & 0xFFFF) as f32 / 65_536.0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The scatter hash stays in `[0, 1)` for many inputs (no out-of-range spawn
    /// positions / NaN), and is not a constant (it actually varies).
    #[test]
    fn hash01_is_bounded_and_varied() {
        let mut min = f32::INFINITY;
        let mut max = f32::NEG_INFINITY;
        for n in 0..1000u32 {
            let v = hash01(n.wrapping_mul(3));
            assert!((0.0..1.0).contains(&v), "hash01 out of range: {v}");
            min = min.min(v);
            max = max.max(v);
        }
        assert!(max - min > 0.5, "scatter should span the range, got {min}..{max}");
    }

    /// A batch never exceeds the cap: when near `MAX_BODIES`, only the remaining
    /// room is spawned (so the count can't run away). This checks the pure count
    /// math `spawn_batch` uses.
    #[test]
    fn batch_respects_cap() {
        // Plenty of room → a full batch.
        let room = MAX_BODIES.saturating_sub(0);
        assert_eq!(room.min(BATCH_SIZE), BATCH_SIZE);
        // Almost full → only the remainder.
        let existing = MAX_BODIES - 30;
        assert_eq!(MAX_BODIES.saturating_sub(existing).min(BATCH_SIZE), 30);
        // Full → nothing.
        assert_eq!(MAX_BODIES.saturating_sub(MAX_BODIES).min(BATCH_SIZE), 0);
    }
}
