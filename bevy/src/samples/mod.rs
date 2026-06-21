//! Sample registry — the single place where every sample is listed.
//!
//! THE CONTRACT (what `/dev-all` repeats for each new sample):
//!   * Each sample is its own module `samples/sNN_name.rs`.
//!   * It exposes a Bevy `Plugin` (e.g. `pub struct CharacterControllerPlugin;`).
//!   * It exposes `pub const META: SampleMeta = SampleMeta { .. }`.
//!   * Its gameplay systems are gated on its own `AppState` variant and its
//!     spawned entities are tagged `DespawnOnExit(AppState::SNN...)` so leaving
//!     the sample auto-cleans up (Bevy 0.18 scoped-entity despawn — NOTE the
//!     0.18 name is `DespawnOnExit`, the older `StateScoped` is gone).
//!   * It is registered in `ALL` below + given an `AppState` arm + wired in
//!     `register_samples` here.

use bevy::prelude::*;

pub mod s01_character_controller;
pub mod s02_physics_grab_throw;
pub mod s03_paint_on_mesh;
pub mod s04_first_person_controller;
pub mod s05_spatial_audio;
pub mod s06_hide_and_seek;
pub mod s08_red_light_green_light;
pub mod s09_coop_carry;

/// Static, render-free metadata for a sample. Cheap to enumerate (e.g. to build
/// the menu) without touching any gameplay system.
///
/// `id`/`tags` are part of the public sample contract (used for deep-linking,
/// logging, and search by tooling) even though the current minimal menu only
/// renders `title`/`summary` — hence `allow(dead_code)`.
#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
pub struct SampleMeta {
    /// Stable kebab-ish id, also used for deep-linking / logging.
    pub id: &'static str,
    /// Human title shown in the menu.
    pub title: &'static str,
    /// One-line description shown under the title.
    pub summary: &'static str,
    /// Free-form tags for filtering/search.
    pub tags: &'static [&'static str],
}

/// Gallery + per-sample states. `Menu` is the landing list; every sample gets
/// exactly one running variant. Selecting a sample transitions Menu -> SNN...;
/// pressing Escape transitions back to Menu (which despawns the sample's
/// `DespawnOnExit`-tagged entities).
#[derive(States, Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum AppState {
    #[default]
    Menu,
    S01CharacterController,
    S02PhysicsGrabThrow,
    S03PaintOnMesh,
    S04FirstPersonController,
    S05SpatialAudio,
    S06HideAndSeek,
    S08RedLightGreenLight,
    S09CoopCarry,
}

/// One menu row: its metadata + the `AppState` selecting it enters.
pub struct SampleEntry {
    pub meta: SampleMeta,
    pub state: AppState,
}

/// Every sample, in display order. Add new samples here.
pub fn all() -> Vec<SampleEntry> {
    vec![
        SampleEntry {
            meta: s01_character_controller::META,
            state: AppState::S01CharacterController,
        },
        SampleEntry {
            meta: s02_physics_grab_throw::META,
            state: AppState::S02PhysicsGrabThrow,
        },
        SampleEntry {
            meta: s03_paint_on_mesh::META,
            state: AppState::S03PaintOnMesh,
        },
        SampleEntry {
            meta: s04_first_person_controller::META,
            state: AppState::S04FirstPersonController,
        },
        SampleEntry {
            meta: s05_spatial_audio::META,
            state: AppState::S05SpatialAudio,
        },
        SampleEntry {
            meta: s06_hide_and_seek::META,
            state: AppState::S06HideAndSeek,
        },
        SampleEntry {
            meta: s08_red_light_green_light::META,
            state: AppState::S08RedLightGreenLight,
        },
        SampleEntry {
            meta: s09_coop_carry::META,
            state: AppState::S09CoopCarry,
        },
    ]
}

/// Registers every sample's `Plugin`. Each plugin internally gates its systems
/// on its own `AppState` arm, so adding the plugin unconditionally here is safe.
pub fn register_samples(app: &mut App) {
    app.add_plugins((
        s01_character_controller::CharacterControllerPlugin,
        s02_physics_grab_throw::PhysicsGrabThrowPlugin,
        s03_paint_on_mesh::PaintOnMeshPlugin,
        s04_first_person_controller::FirstPersonControllerPlugin,
        s05_spatial_audio::SpatialAudioPlugin,
        s06_hide_and_seek::HideAndSeekPlugin,
        s08_red_light_green_light::RedLightGreenLightPlugin,
        s09_coop_carry::CoopCarryPlugin,
    ));
}
