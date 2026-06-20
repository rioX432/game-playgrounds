//! Shared scene primitives — reusable spawn helpers for the boilerplate every
//! sample repeats: a ground plane, a directional light preset, and a grid of
//! boxes. Cuts copy-paste so a new sample can stand up a stage in a few lines.
//!
//! ## Ownership model (mirrors `engine::hud`)
//! These are PER-SAMPLE spawn HELPER FUNCTIONS, NOT a plugin. A sample calls
//! them from its `OnEnter` setup; each helper tags the entities it spawns with
//! `DespawnOnExit(state)` INTERNALLY, so the spawned scene is owned by the
//! calling sample and auto-cleans on `Esc` with NO teardown system and NO
//! double-cleanup. There is deliberately no scene plugin: scene entities are
//! sample-owned, so the only cleanup path is the built-in `DespawnOnExit`.
//!
//! Each helper takes the sample's `AppState` scope so it tags correctly, and
//! returns the spawned `Entity` id(s) where a caller may want to reference them.
//!
//! ## Bevy 0.18 gotchas (verified against the existing inline s01/s02 code)
//!   * Meshes spawn as `Mesh3d(handle)` + `MeshMaterial3d(handle)` — no
//!     `PbrBundle`. Ground via `Plane3d::default().mesh().size(w, h)`, boxes via
//!     `Cuboid::new(..)`.
//!   * Lights are direct components (`DirectionalLight { .. }` + `Transform`) —
//!     no `DirectionalLightBundle`. Ambient light is the `AmbientLight`
//!     resource, not an entity, so the preset returns the entity only for the
//!     directional light and leaves ambient to `main.rs` defaults.
//!   * Scoped cleanup is `DespawnOnExit(state)` (0.18), NOT `StateScoped`.

use bevy::prelude::*;

use crate::samples::AppState;

/// Side length (world units) of the square ground plane.
const GROUND_SIZE: f32 = 40.0;
/// Default ground tint (a muted green).
const GROUND_COLOR: Color = Color::srgb(0.3, 0.5, 0.3);

/// Edge length (world units) of each box in [`spawn_box_grid`].
const BOX_SIZE: f32 = 1.0;
/// Spacing (world units) between box centers in the grid.
const BOX_SPACING: f32 = 2.0;
/// Default box tint (a warm orange).
const BOX_COLOR: Color = Color::srgb(0.9, 0.5, 0.2);

/// Illuminance (lux) of the preset directional light — matches the value the
/// samples used inline before this module existed.
const LIGHT_ILLUMINANCE: f32 = 10_000.0;
/// World position the preset directional light is placed at (it then looks at
/// the origin). Only the direction matters for a directional light, but a
/// concrete position keeps shadow framing predictable.
const LIGHT_POSITION: Vec3 = Vec3::new(4.0, 8.0, 4.0);

/// Spawns a flat square ground plane at the origin, tinted [`GROUND_COLOR`] and
/// tagged `DespawnOnExit(state)` so it auto-cleans on sample exit. Returns the
/// ground entity. Render-only: add a collider in the sample if physics is
/// needed (this primitive stays renderer-pure so non-physics samples can use
/// it).
pub fn spawn_ground(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    materials: &mut Assets<StandardMaterial>,
    state: AppState,
) -> Entity {
    commands
        .spawn((
            Mesh3d(meshes.add(Plane3d::default().mesh().size(GROUND_SIZE, GROUND_SIZE))),
            MeshMaterial3d(materials.add(StandardMaterial {
                base_color: GROUND_COLOR,
                ..default()
            })),
            Transform::IDENTITY,
            DespawnOnExit(state),
        ))
        .id()
}

/// Computes the world-space center positions of a `cols`×`rows` box grid on the
/// XZ plane, centered on the origin, with [`BOX_SPACING`] between centers and
/// each box resting on the ground (`y = BOX_SIZE / 2`).
///
/// Pure (no ECS) so headless tests can assert the layout without a window.
pub fn box_grid_positions(cols: u32, rows: u32) -> Vec<Vec3> {
    let mut out = Vec::with_capacity((cols * rows) as usize);
    // Offset so the grid is centered on the origin: the span of `n` centers is
    // `(n - 1) * spacing`, half of which shifts the first center to the left.
    let x_offset = (cols.saturating_sub(1)) as f32 * BOX_SPACING * 0.5;
    let z_offset = (rows.saturating_sub(1)) as f32 * BOX_SPACING * 0.5;
    let y = BOX_SIZE * 0.5;
    for r in 0..rows {
        for c in 0..cols {
            let x = c as f32 * BOX_SPACING - x_offset;
            let z = r as f32 * BOX_SPACING - z_offset;
            out.push(Vec3::new(x, y, z));
        }
    }
    out
}

/// Spawns a `cols`×`rows` grid of boxes (each [`BOX_SIZE`] on a side) centered
/// on the origin, tinted [`BOX_COLOR`] and tagged `DespawnOnExit(state)` so they
/// auto-clean on sample exit. Returns the spawned box entities in row-major
/// order. Render-only (no colliders) — see [`spawn_ground`].
pub fn spawn_box_grid(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    materials: &mut Assets<StandardMaterial>,
    state: AppState,
    cols: u32,
    rows: u32,
) -> Vec<Entity> {
    // Share one mesh + material handle across the whole grid (cheap, identical
    // boxes); each box still gets its own Transform and despawn scope.
    let mesh = meshes.add(Cuboid::new(BOX_SIZE, BOX_SIZE, BOX_SIZE));
    let material = materials.add(StandardMaterial {
        base_color: BOX_COLOR,
        ..default()
    });

    box_grid_positions(cols, rows)
        .into_iter()
        .map(|pos| {
            commands
                .spawn((
                    Mesh3d(mesh.clone()),
                    MeshMaterial3d(material.clone()),
                    Transform::from_translation(pos),
                    DespawnOnExit(state),
                ))
                .id()
        })
        .collect()
}

/// Spawns the standard directional light preset (single key light aimed at the
/// origin with shadows), tagged `DespawnOnExit(state)` so it auto-cleans on
/// sample exit. Returns the light entity.
///
/// Ambient fill is intentionally NOT spawned here: ambient light in Bevy 0.18 is
/// the global `AmbientLight` resource (not a scoped entity), so a per-sample
/// helper can't tag it for `DespawnOnExit`. Samples rely on the app-wide default
/// ambient; tune it in `main.rs` if a brighter fill is wanted globally.
pub fn spawn_light_preset(commands: &mut Commands, state: AppState) -> Entity {
    commands
        .spawn((
            DirectionalLight {
                illuminance: LIGHT_ILLUMINANCE,
                shadows_enabled: true,
                ..default()
            },
            Transform::from_translation(LIGHT_POSITION).looking_at(Vec3::ZERO, Vec3::Y),
            DespawnOnExit(state),
        ))
        .id()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A grid produces exactly `cols * rows` positions.
    #[test]
    fn box_grid_positions_has_expected_count() {
        assert_eq!(box_grid_positions(3, 2).len(), 6);
        assert_eq!(box_grid_positions(1, 1).len(), 1);
        assert_eq!(box_grid_positions(0, 5).len(), 0);
    }

    /// The grid is centered on the origin: for an odd count per axis the middle
    /// box sits at x/z = 0; every box rests on the ground at y = BOX_SIZE/2.
    #[test]
    fn box_grid_is_centered_and_on_ground() {
        let positions = box_grid_positions(3, 3);
        // Center of a 3x3 grid is the 5th (index 4) entry in row-major order.
        let center = positions[4];
        assert_eq!(center.x, 0.0, "middle column should be centered on x=0");
        assert_eq!(center.z, 0.0, "middle row should be centered on z=0");
        for p in &positions {
            assert_eq!(p.y, BOX_SIZE * 0.5, "boxes rest on the ground");
        }
    }

    /// Adjacent boxes in a row are exactly `BOX_SPACING` apart on x.
    #[test]
    fn box_grid_spacing_is_uniform() {
        let positions = box_grid_positions(2, 1);
        let dx = (positions[1].x - positions[0].x).abs();
        assert_eq!(dx, BOX_SPACING, "adjacent box centers are one spacing apart");
    }
}
