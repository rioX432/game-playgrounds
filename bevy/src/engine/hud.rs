//! Shared foundation HUD module (controls overlay + FPS counter).
//!
//! Split into two halves so the same boundary as `engine::input` applies —
//! GLOBAL app infrastructure added ONCE vs PER-SAMPLE entities that come and go:
//!
//!   * [`FoundationHudPlugin`] — a **global** plugin added ONCE in `main.rs`. It
//!     registers Bevy's [`FrameTimeDiagnosticsPlugin`] (the app-wide frame-time
//!     measurement) and runs one update system that writes the smoothed FPS into
//!     the FPS-counter text entity **if one exists**. It owns NO entities and
//!     no-ops harmlessly when no sample has spawned a HUD.
//!   * [`spawn_controls_overlay`] / [`spawn_fps_counter`] — PER-SAMPLE spawn
//!     helpers (NOT a plugin) that a sample calls from its `OnEnter` setup. They
//!     tag the spawned UI with `DespawnOnExit(state)` INTERNALLY, so leaving the
//!     sample auto-cleans the HUD up (cleanup stays scoped — no manual teardown).
//!
//! ## Why diagnostics is global, not per-sample
//! `FrameTimeDiagnosticsPlugin` can only be added once; adding it on every
//! sample `OnEnter` would double-register the plugin (a panic / bug). It is
//! cheap app infrastructure that intentionally persists for the whole process.
//! Only the *display* entity is per-sample.
//!
//! ## Layout
//! The gallery menu owns the center of the screen, so the HUD stays out of its
//! way: the controls overlay sits bottom-left and the FPS counter top-right.
//! Neither duplicates the sample title (the menu already shows it).
//!
//! ## Bevy 0.18 gotchas (verified against avvy-world `hud.rs`)
//!   * FPS lives in `Res<DiagnosticsStore>`; read it with
//!     `diagnostics.get(&FrameTimeDiagnosticsPlugin::FPS)` then `.smoothed()`.
//!   * UI is `Node` + `Text::new(..)` + `TextFont`/`TextColor` — no
//!     `NodeBundle`/`TextBundle`/`Style`. Absolute placement via `Node`'s
//!     `position_type`/`top`/`left`/`right`.
//!   * Scoped cleanup is `DespawnOnExit(state)` (0.18), NOT `StateScoped`.

use bevy::diagnostic::{DiagnosticsStore, FrameTimeDiagnosticsPlugin};
use bevy::prelude::*;

use crate::samples::AppState;

/// Font size (px) for the controls overlay lines.
const CONTROLS_FONT_SIZE: f32 = 14.0;
/// Font size (px) for the FPS counter.
const FPS_FONT_SIZE: f32 = 16.0;
/// Inset (px) of both HUD widgets from the window edges.
const HUD_INSET: f32 = 8.0;
/// Placeholder shown until the first FPS sample is available.
const FPS_PLACEHOLDER: &str = "FPS: --";

/// Marker for the FPS-counter text entity. The global [`update_fps_text`] system
/// queries this; a sample spawns at most one via [`spawn_fps_counter`].
#[derive(Component, Debug)]
pub struct FpsText;

/// Global HUD plugin. Add ONCE in `main.rs`. Registers frame-time diagnostics
/// (app-wide, persistent) and drives the FPS counter when a sample shows one.
pub struct FoundationHudPlugin;

impl Plugin for FoundationHudPlugin {
    fn build(&self, app: &mut App) {
        // Frame-time diagnostics are global app infrastructure: register ONCE.
        // Samples must NOT add this per-`OnEnter` (double-registration is a bug).
        app.add_plugins(FrameTimeDiagnosticsPlugin::default())
            // Only runs while a sample is active (never in the menu, where no FPS
            // counter exists). The query also no-ops if no counter was spawned.
            .add_systems(
                Update,
                update_fps_text.run_if(not(in_state(AppState::Menu))),
            );
    }
}

/// Spawns a controls/help overlay (one [`Text`] line per entry) pinned to the
/// bottom-left, tagged `DespawnOnExit(state)` so it auto-cleans on sample exit.
///
/// `lines` are rendered top-to-bottom in order; pass control hints like
/// `"WASD — move"`. Does not include the sample title (the menu shows it).
pub fn spawn_controls_overlay(commands: &mut Commands, state: AppState, lines: &[&str]) {
    commands
        .spawn((
            DespawnOnExit(state),
            Node {
                position_type: PositionType::Absolute,
                bottom: Val::Px(HUD_INSET),
                left: Val::Px(HUD_INSET),
                flex_direction: FlexDirection::Column,
                row_gap: Val::Px(2.0),
                ..default()
            },
        ))
        .with_children(|parent| {
            for line in lines {
                parent.spawn((
                    Text::new(*line),
                    TextFont {
                        font_size: CONTROLS_FONT_SIZE,
                        ..default()
                    },
                    TextColor(Color::srgb(0.85, 0.85, 0.9)),
                ));
            }
        });
}

/// Spawns the FPS counter (top-right), tagged with [`FpsText`] so the global
/// [`update_fps_text`] system fills it in, and `DespawnOnExit(state)` so it
/// auto-cleans on sample exit. Shows [`FPS_PLACEHOLDER`] until the first sample.
pub fn spawn_fps_counter(commands: &mut Commands, state: AppState) {
    commands.spawn((
        FpsText,
        DespawnOnExit(state),
        Text::new(FPS_PLACEHOLDER),
        TextFont {
            font_size: FPS_FONT_SIZE,
            ..default()
        },
        TextColor(Color::srgb(0.0, 1.0, 0.0)),
        Node {
            position_type: PositionType::Absolute,
            top: Val::Px(HUD_INSET),
            right: Val::Px(HUD_INSET),
            ..default()
        },
    ));
}

/// Formats a smoothed FPS value into the counter's display string. Pure helper
/// so headless tests can verify formatting without a window/diagnostics.
fn format_fps(fps: f64) -> String {
    format!("FPS: {fps:.0}")
}

/// Global system: writes the smoothed FPS into the [`FpsText`] entity if one
/// exists. No-ops safely when no sample has spawned a counter (empty query) or
/// before the first diagnostic sample is available.
fn update_fps_text(diagnostics: Res<DiagnosticsStore>, mut query: Query<&mut Text, With<FpsText>>) {
    let Some(fps) = diagnostics
        .get(&FrameTimeDiagnosticsPlugin::FPS)
        .and_then(|d| d.smoothed())
    else {
        return;
    };
    for mut text in &mut query {
        **text = format_fps(fps);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// FPS formatting rounds to a whole number with the `FPS:` prefix.
    #[test]
    fn format_fps_rounds_to_whole_number() {
        assert_eq!(format_fps(59.7), "FPS: 60");
        assert_eq!(format_fps(60.0), "FPS: 60");
        assert_eq!(format_fps(0.4), "FPS: 0");
    }

    /// The global update system no-ops (does not panic) when no FPS counter
    /// entity exists — proving the helper-vs-global split is safe without a HUD.
    #[test]
    fn update_fps_text_no_ops_without_counter() {
        let mut app = App::new();
        app.add_plugins(MinimalPlugins);
        app.init_resource::<DiagnosticsStore>();
        app.add_systems(Update, update_fps_text);
        // No FpsText entity spawned: the system must run cleanly.
        app.update();
    }
}
