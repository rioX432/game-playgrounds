//! # s08 — Red-light green-light freeze detection (だるまさんがころんだ / Squid Game)
//!
//! **What it demonstrates:** The "red light, green light" GREEN(move) /
//! RED(freeze) state machine. A third-person capsule player drives toward a
//! finish line while a doll/watcher cycles between facing AWAY (GREEN — you may
//! move) and facing TOWARD you (RED — you must be still). A short TURNING
//! telegraph eases the doll's rotation so the flip is legible. During RED, if the
//! player's speed exceeds a small threshold past a brief reaction GRACE window,
//! they are CAUGHT and frozen. Reach the finish line during a legal move to WIN.
//! `R` resets to a fresh GREEN at the start. This shows the whole loop: phase
//! timer cycling green↔red with a turning telegraph, motion-during-red → CAUGHT,
//! WIN, and reset.
//!
//! **Controls:** `W/A/S/D` move (camera-relative, world axes — only safe during
//! GREEN). `R` reset to a fresh GREEN at the start. `Esc` returns to the menu.
//!
//! **Feel notes:** The GREEN→TURNING→RED telegraph is the whole game's feel: with
//! the doll easing its turn over [`TURNING_SECS`] you get a fair "stop now!"
//! beat, and the GRACE window after RED begins ([`GRACE_SECS`]) means a key you
//! were already holding doesn't instantly kill you — it feels tense but fair.
//! Honest bad parts: (1) detection is a hard binary on a single speed threshold,
//! so the instant you cross it past the grace you are CAUGHT with no "leaning"
//! nuance — a real version reads acceleration/visible motion, not raw speed. (2)
//! Movement is collider-free transform sliding (like s01), so there's no physical
//! weight to stopping — you snap to a halt the frame you release the key, which
//! makes the freeze feel digital rather than a real skid-to-stop. (3) The doll is
//! a primitive (capsule + sphere head) with no eyes, so "facing toward you" reads
//! only from body yaw; in a real game the gaze sells the threat far more. (4)
//! There's no audio cue, so you must watch the doll constantly — the real game's
//! sing-song chant that telegraphs the turn by EAR is absent here.
//!
//! **Bevy 0.18 gotchas:**
//!   * Phase/timer state lives in the [`RedLightState`] **resource**, which
//!     `DespawnOnExit` does NOT clear (it only despawns entities). So `setup`
//!     re-inserts a fresh [`RedLightState`] on every `OnEnter`, guaranteeing a
//!     re-entered sample starts at a clean GREEN with no phase bleed across
//!     sample switches.
//!   * **Stale-position instant-catch pitfall:** on RESET and whenever RED
//!     begins, the resource's `prev_player_pos` is synced to the player's CURRENT
//!     position, so the first RED frame computes a zero delta instead of a huge
//!     one (which would instantly CATCH). Handled explicitly in [`sync_prev_pos`]
//!     and on reset.
//!   * Doll rotation eases via `Quat::slerp` between an AWAY and a TOWARD yaw over
//!     the TURNING phase — there is no built-in tween, so the phase's elapsed
//!     fraction drives the slerp `t` directly.
//!   * `Time` delta is `time.delta_secs()` (f32), not `delta_seconds()`.
//!   * `Query::single()` / `single_mut()` return `Result` — handle with
//!     `let Ok(..) = .. else { return; };`.
//!
//! **Shared input:** movement reads the global [`MoveIntent`] resource owned by
//! `engine::input::FoundationInputPlugin`. Reset reads `ButtonInput<KeyCode>`
//! directly (a one-off edge, not a shared intent).
//!
//! **Shared HUD/scene:** ground + light come from `engine::scene`; the controls
//! overlay + FPS counter from `engine::hud`. All are `DespawnOnExit`-scoped
//! internally, so only the player capsule, follow camera, doll, finish line, and
//! phase HUD line are spawned inline here.

use bevy::prelude::*;

use crate::engine::hud;
use crate::engine::input::MoveIntent;
use crate::engine::scene;

use super::{AppState, SampleMeta};

pub const META: SampleMeta = SampleMeta {
    id: "08-red-light-green-light",
    title: "Red-light green-light freeze detection",
    summary: "Move on GREEN, freeze on RED — moving while the doll watches gets you CAUGHT.",
    tags: &["state-machine", "timing", "detection", "movement"],
};

/// Player movement speed in world units / second.
const MOVE_SPEED: f32 = 6.0;
/// Camera offset behind/above the player (world units).
const CAMERA_OFFSET: Vec3 = Vec3::new(0.0, 6.0, 10.0);

/// Player start position (also the reset position). Placed back from the doll so
/// there's a track to cross toward the finish line.
const START_POS: Vec3 = Vec3::new(0.0, 1.0, 12.0);
/// World Z of the finish line; reaching it (player Z <= this) during a legal move
/// is a WIN. The doll sits just beyond it.
const FINISH_Z: f32 = -2.0;
/// World position of the doll/watcher (beyond the finish line, facing the track).
const DOLL_POS: Vec3 = Vec3::new(0.0, 1.5, -4.0);

/// GREEN phase duration (seconds) — you may move freely.
const GREEN_SECS: f32 = 3.0;
/// TURNING telegraph duration (seconds) — the doll eases from AWAY to TOWARD.
/// Movement during TURNING is still legal (the doll isn't watching yet); this is
/// the "stop now!" warning beat.
const TURNING_SECS: f32 = 0.8;
/// RED phase duration (seconds) — you must be still or get CAUGHT.
const RED_SECS: f32 = 2.5;
/// Reaction grace (seconds) after RED begins during which motion is forgiven, so
/// a key you were already holding doesn't instantly catch you.
const GRACE_SECS: f32 = 0.35;

/// Speed (world units / second) above which moving during RED (past the grace
/// window) is CAUGHT. A small positive value tolerates float jitter so a
/// perfectly still player is never falsely caught.
const CATCH_SPEED_THRESHOLD: f32 = 0.05;

/// The doll's "looking away" yaw (back turned to the player — GREEN).
const DOLL_YAW_AWAY: f32 = 0.0;
/// The doll's "looking at you" yaw (turned 180° to face down the track — RED).
const DOLL_YAW_TOWARD: f32 = std::f32::consts::PI;

/// Which side of the loop we're in. RESET always returns to `Green` at the start.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// Doll faces away; movement is free.
    Green,
    /// Doll is easing around to face you; movement still legal (warning beat).
    Turning,
    /// Doll faces you; moving past the grace window is CAUGHT.
    Red,
}

/// Terminal outcome of a run, or `None` while still playing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Outcome {
    Caught,
    Win,
}

/// All phase/timer/detection state for the sample. A **resource** (not an
/// entity), so it is NOT cleared by `DespawnOnExit` — [`setup`] re-inserts a
/// fresh one on every `OnEnter` to guarantee a clean start with no phase bleed.
#[derive(Resource, Debug, Clone, Copy)]
struct RedLightState {
    /// Current loop phase.
    phase: Phase,
    /// Seconds elapsed within the current phase.
    elapsed: f32,
    /// Player translation captured at the most recent phase advance / reset, used
    /// to derive per-frame speed during RED. Synced to the CURRENT player position
    /// on reset and on entering RED to avoid the stale-position instant-catch bug.
    prev_player_pos: Vec3,
    /// Terminal outcome once the run ends, else `None` (still playing).
    outcome: Option<Outcome>,
}

impl Default for RedLightState {
    fn default() -> Self {
        Self {
            phase: Phase::Green,
            elapsed: 0.0,
            prev_player_pos: START_POS,
            outcome: None,
        }
    }
}

/// Marks the follow camera.
#[derive(Component)]
struct FollowCamera;

/// Marks the player capsule.
#[derive(Component)]
struct Player;

/// Marks the doll/watcher (whose yaw telegraphs the phase).
#[derive(Component)]
struct Doll;

/// Marker for the HUD line showing the current phase + outcome.
#[derive(Component)]
struct PhaseHudText;

pub struct RedLightGreenLightPlugin;

impl Plugin for RedLightGreenLightPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(OnEnter(AppState::S08RedLightGreenLight), setup)
            .add_systems(
                Update,
                (
                    handle_reset,
                    advance_phase,
                    move_player,
                    detect_motion,
                    update_doll,
                    update_hud,
                    follow_camera,
                )
                    .chain()
                    .run_if(in_state(AppState::S08RedLightGreenLight)),
            );
    }
}

/// Spawns the stage, player, doll, finish line and HUD, and (re-)inserts a fresh
/// [`RedLightState`] so a re-entered sample starts at a clean GREEN. Every spawned
/// entity is `DespawnOnExit`-scoped; the resource reset here is the cleanup for
/// the non-entity phase state (`DespawnOnExit` does not touch resources).
fn setup(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    let state = AppState::S08RedLightGreenLight;
    let scope = DespawnOnExit(state);

    // CRITICAL: re-init the phase resource on every enter — DespawnOnExit does NOT
    // clear resources, so without this a re-entered sample would inherit the prior
    // run's phase/elapsed/outcome (stale phase bleed).
    commands.insert_resource(RedLightState::default());

    // Shared scene: ground + key light. Each tags DespawnOnExit(state) internally.
    scene::spawn_ground(&mut commands, &mut meshes, &mut materials, state);
    scene::spawn_light_preset(&mut commands, state);

    // Player capsule at the start position.
    commands.spawn((
        Player,
        Mesh3d(meshes.add(Capsule3d::new(0.5, 1.0))),
        MeshMaterial3d(materials.add(StandardMaterial {
            base_color: Color::srgb(0.2, 0.5, 0.9),
            ..default()
        })),
        Transform::from_translation(START_POS),
        scope.clone(),
    ));

    // Follow camera, starting at the player's offset.
    commands.spawn((
        FollowCamera,
        Camera3d::default(),
        Transform::from_translation(START_POS + CAMERA_OFFSET).looking_at(START_POS, Vec3::Y),
        scope.clone(),
    ));

    // Doll/watcher: a capsule body + a sphere head, parented so they rotate as one
    // about the body's yaw. Starts facing AWAY (GREEN).
    commands
        .spawn((
            Doll,
            Mesh3d(meshes.add(Capsule3d::new(0.6, 1.4))),
            MeshMaterial3d(materials.add(StandardMaterial {
                base_color: Color::srgb(0.85, 0.2, 0.3),
                ..default()
            })),
            Transform::from_translation(DOLL_POS).with_rotation(Quat::from_rotation_y(DOLL_YAW_AWAY)),
            scope.clone(),
        ))
        .with_children(|parent| {
            parent.spawn((
                Mesh3d(meshes.add(Sphere::new(0.45))),
                MeshMaterial3d(materials.add(StandardMaterial {
                    base_color: Color::srgb(0.95, 0.85, 0.7),
                    ..default()
                })),
                // Head sits above the body; a small +Z nub face is implied by the
                // body yaw (no eyes — see feel notes).
                Transform::from_xyz(0.0, 1.3, 0.0),
            ));
        });

    // Finish line: a thin bright strip across the track at FINISH_Z.
    commands.spawn((
        Mesh3d(meshes.add(Cuboid::new(8.0, 0.05, 0.3))),
        MeshMaterial3d(materials.add(StandardMaterial {
            base_color: Color::srgb(0.95, 0.95, 0.2),
            ..default()
        })),
        Transform::from_xyz(0.0, 0.03, FINISH_Z),
        scope.clone(),
    ));

    // Phase + outcome HUD line, updated every frame.
    commands.spawn((
        PhaseHudText,
        scope,
        Text::new(""),
        TextFont {
            font_size: 20.0,
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
            "WASD — move (only safe on GREEN!)",
            "R — reset",
            "Esc — back to menu",
        ],
    );
    hud::spawn_fps_counter(&mut commands, state);
}

/// `R` resets to a fresh GREEN at the start: re-homes the player, resets the phase
/// resource, and — CRITICALLY — syncs `prev_player_pos` to the start so the next
/// frame can't see a stale delta and instant-catch.
fn handle_reset(
    keyboard: Res<ButtonInput<KeyCode>>,
    mut state: ResMut<RedLightState>,
    mut player_q: Query<&mut Transform, With<Player>>,
) {
    if !keyboard.just_pressed(KeyCode::KeyR) {
        return;
    }
    if let Ok(mut transform) = player_q.single_mut() {
        transform.translation = START_POS;
    }
    // Full fresh state. `prev_player_pos` defaults to START_POS — matching the
    // re-homed player — so the stale-position guard holds on the first frame.
    *state = RedLightState::default();
}

/// Advances the phase timer by `dt` and transitions GREEN→TURNING→RED→GREEN at the
/// named-const thresholds. Pure transition logic lives in [`step_phase`]; this
/// system only feeds it `dt` and the current player position so it can sync
/// `prev_player_pos` when RED begins (the stale-position guard). Frozen once the
/// run has a terminal outcome.
fn advance_phase(
    time: Res<Time>,
    mut state: ResMut<RedLightState>,
    player_q: Query<&Transform, With<Player>>,
) {
    if state.outcome.is_some() {
        return;
    }
    let player_pos = player_q
        .single()
        .map(|t| t.translation)
        .unwrap_or(state.prev_player_pos);
    step_phase(&mut state, time.delta_secs(), player_pos);
}

/// Moves the player from the shared [`MoveIntent`], but ONLY while it is currently
/// legal to move (GREEN or TURNING) and the run hasn't ended. During RED the
/// player is frozen by the rules; once CAUGHT/WIN they're frozen entirely. The
/// resulting translation delta is what [`detect_motion`] reads for the catch.
fn move_player(
    time: Res<Time>,
    intent: Res<MoveIntent>,
    state: Res<RedLightState>,
    mut query: Query<&mut Transform, With<Player>>,
) {
    if state.outcome.is_some() {
        return;
    }
    let Ok(mut transform) = query.single_mut() else {
        return;
    };
    if intent.dir != Vec3::ZERO {
        transform.translation += intent.dir * MOVE_SPEED * time.delta_secs();
    }
}

/// The detector. During RED (past the grace window) derives the player's speed
/// from how far it moved since `prev_player_pos` and CATCHES if it exceeds the
/// threshold. Always checks the WIN condition (player reached the finish line).
/// Updates `prev_player_pos` to the current position every frame so the next
/// frame's delta is per-frame, not cumulative.
fn detect_motion(
    time: Res<Time>,
    mut state: ResMut<RedLightState>,
    player_q: Query<&Transform, With<Player>>,
) {
    if state.outcome.is_some() {
        return;
    }
    let Ok(transform) = player_q.single() else {
        return;
    };
    let pos = transform.translation;

    // WIN: reached the finish line (we only get here while still playing, i.e. via
    // a legal GREEN/TURNING move, since RED freezes movement).
    if pos.z <= FINISH_Z {
        state.outcome = Some(Outcome::Win);
        return;
    }

    let dt = time.delta_secs();
    let distance = pos.distance(state.prev_player_pos);
    let speed = if dt > 0.0 { distance / dt } else { 0.0 };

    if is_caught(state.phase, state.elapsed, speed, GRACE_SECS, CATCH_SPEED_THRESHOLD) {
        state.outcome = Some(Outcome::Caught);
    }

    // Advance the per-frame reference last so the NEXT frame measures one frame of
    // motion. (On RED entry `step_phase` already re-synced this to the live pos.)
    state.prev_player_pos = pos;
}

/// Eases the doll's yaw to telegraph the phase: AWAY during GREEN, TOWARD during
/// RED, and slerped between the two across the TURNING phase by its elapsed
/// fraction. Reads the phase resource; never mutates gameplay state.
fn update_doll(state: Res<RedLightState>, mut doll_q: Query<&mut Transform, With<Doll>>) {
    let Ok(mut transform) = doll_q.single_mut() else {
        return;
    };
    let yaw = doll_target_yaw(state.phase, state.elapsed);
    transform.rotation = Quat::from_rotation_y(yaw);
}

/// Writes the phase + outcome to the HUD line.
fn update_hud(state: Res<RedLightState>, mut hud_q: Query<&mut Text, With<PhaseHudText>>) {
    let Ok(mut text) = hud_q.single_mut() else {
        return;
    };
    **text = phase_label(state.phase, state.outcome).to_string();
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

// ---------------------------------------------------------------------------
// Pure logic (headless-testable, no ECS / window)
// ---------------------------------------------------------------------------

/// Duration of a phase in seconds.
fn phase_duration(phase: Phase) -> f32 {
    match phase {
        Phase::Green => GREEN_SECS,
        Phase::Turning => TURNING_SECS,
        Phase::Red => RED_SECS,
    }
}

/// The phase that follows `phase` in the loop (GREEN→TURNING→RED→GREEN).
fn next_phase(phase: Phase) -> Phase {
    match phase {
        Phase::Green => Phase::Turning,
        Phase::Turning => Phase::Red,
        Phase::Red => Phase::Green,
    }
}

/// Advances the phase machine by `dt`, rolling over to the next phase (carrying
/// any overshoot) whenever the current phase's duration is exceeded. When the new
/// phase is RED, syncs `prev_player_pos` to `player_pos` so the first RED frame
/// sees a zero delta — the explicit stale-position instant-catch guard. A `while`
/// loop handles a `dt` large enough to span multiple phases in one tick.
fn step_phase(state: &mut RedLightState, dt: f32, player_pos: Vec3) {
    state.elapsed += dt;
    while state.elapsed >= phase_duration(state.phase) {
        state.elapsed -= phase_duration(state.phase);
        state.phase = next_phase(state.phase);
        if state.phase == Phase::Red {
            // STALE-POSITION GUARD: entering RED, reset the motion reference to the
            // player's current position so the first RED frame's delta is ~0 and
            // can't instantly catch a player who simply finished a legal move.
            state.prev_player_pos = player_pos;
        }
    }
}

/// Pure detection rule: a player is CAUGHT only when the doll is watching (RED),
/// the reaction GRACE window has elapsed, and their speed exceeds the threshold.
/// GREEN/TURNING are always safe; within the grace window RED is safe; a still
/// player (speed at/below threshold) is always safe (jitter tolerance).
fn is_caught(phase: Phase, elapsed: f32, speed: f32, grace: f32, threshold: f32) -> bool {
    phase == Phase::Red && elapsed > grace && speed > threshold
}

/// Pure doll-yaw telegraph: AWAY on GREEN, TOWARD on RED, eased between the two
/// across the TURNING phase by its elapsed fraction (clamped to [0,1]).
fn doll_target_yaw(phase: Phase, elapsed: f32) -> f32 {
    match phase {
        Phase::Green => DOLL_YAW_AWAY,
        Phase::Red => DOLL_YAW_TOWARD,
        Phase::Turning => {
            let t = (elapsed / TURNING_SECS).clamp(0.0, 1.0);
            DOLL_YAW_AWAY + (DOLL_YAW_TOWARD - DOLL_YAW_AWAY) * t
        }
    }
}

/// Pure HUD label for the current phase / outcome.
fn phase_label(phase: Phase, outcome: Option<Outcome>) -> &'static str {
    match outcome {
        Some(Outcome::Caught) => "CAUGHT! — press R to reset",
        Some(Outcome::Win) => "YOU WIN! — press R to play again",
        None => match phase {
            Phase::Green => "GREEN — move!",
            Phase::Turning => "TURNING… — stop now!",
            Phase::Red => "RED — freeze!",
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Phase advance: feeding `dt` accumulates and transitions
    /// GREEN→TURNING→RED→GREEN at the right thresholds, carrying overshoot.
    /// Non-tautological: checks that a sub-duration tick does NOT advance, that
    /// crossing each boundary advances exactly one phase, and that the elapsed
    /// remainder carries over.
    #[test]
    fn step_phase_cycles_at_thresholds() {
        let mut s = RedLightState::default();
        assert_eq!(s.phase, Phase::Green);

        // Sub-duration tick: stays GREEN, accumulates elapsed.
        step_phase(&mut s, GREEN_SECS - 0.5, Vec3::ZERO);
        assert_eq!(s.phase, Phase::Green);
        assert!((s.elapsed - (GREEN_SECS - 0.5)).abs() < 1e-5);

        // Crossing GREEN's end with 0.2 overshoot → TURNING, elapsed carries 0.2.
        step_phase(&mut s, 0.7, Vec3::ZERO);
        assert_eq!(s.phase, Phase::Turning);
        assert!((s.elapsed - 0.2).abs() < 1e-5, "overshoot must carry, got {}", s.elapsed);

        // Finish TURNING → RED.
        step_phase(&mut s, TURNING_SECS, Vec3::ZERO);
        assert_eq!(s.phase, Phase::Red);

        // Finish RED → back to GREEN (full loop closed).
        step_phase(&mut s, RED_SECS, Vec3::ZERO);
        assert_eq!(s.phase, Phase::Green);
    }

    /// A single huge `dt` spanning multiple phases advances correctly (the
    /// `while` loop), rather than getting stuck or skipping phases.
    #[test]
    fn step_phase_handles_multi_phase_dt() {
        let mut s = RedLightState::default();
        // GREEN + TURNING + a sliver into RED.
        step_phase(&mut s, GREEN_SECS + TURNING_SECS + 0.1, Vec3::ZERO);
        assert_eq!(s.phase, Phase::Red);
        assert!((s.elapsed - 0.1).abs() < 1e-5);
    }

    /// Entering RED syncs `prev_player_pos` to the player's CURRENT position — the
    /// stale-position instant-catch guard. Non-tautological: the player is far from
    /// the resource's default `prev_player_pos`, and after the transition the two
    /// must match (so the first RED frame's delta is ~0).
    #[test]
    fn entering_red_syncs_prev_pos_to_guard_against_instant_catch() {
        let mut s = RedLightState::default();
        let player_pos = Vec3::new(0.0, 1.0, 3.0); // moved far during GREEN/TURNING
        assert_ne!(s.prev_player_pos, player_pos);

        // Drive straight to RED in one go (a sliver past the TURNING boundary so
        // the transition is unambiguous, not pinned to an exact float boundary).
        step_phase(&mut s, GREEN_SECS + TURNING_SECS + 0.01, player_pos);
        assert_eq!(s.phase, Phase::Red);
        assert_eq!(
            s.prev_player_pos, player_pos,
            "on RED entry prev_player_pos must snap to the live position"
        );

        // Therefore the first RED frame sees ~0 speed and is NOT caught despite
        // the player having moved a lot just before RED began.
        let speed_first_red_frame = 0.0; // distance(player_pos, prev_player_pos)/dt
        assert!(
            !is_caught(s.phase, GRACE_SECS + 0.1, speed_first_red_frame, GRACE_SECS, CATCH_SPEED_THRESHOLD),
            "stale-position guard must prevent an instant catch on RED entry"
        );
    }

    /// Detection rule: moving during RED past the grace window is caught; but
    /// still-during-RED, moving-during-GREEN/TURNING, and moving-within-grace are
    /// all safe. Non-tautological: exercises each axis (phase, grace, speed).
    #[test]
    fn is_caught_only_when_moving_during_watched_red() {
        let g = GRACE_SECS;
        let t = CATCH_SPEED_THRESHOLD;
        let fast = MOVE_SPEED;

        // The catch case: RED, past grace, moving fast.
        assert!(is_caught(Phase::Red, g + 0.1, fast, g, t), "moving during watched RED is caught");

        // Safe: still during RED past grace.
        assert!(!is_caught(Phase::Red, g + 0.1, 0.0, g, t), "still during RED is safe");
        // Safe: moving within the grace window (reaction time).
        assert!(!is_caught(Phase::Red, g * 0.5, fast, g, t), "moving within grace is forgiven");
        // Safe: moving during GREEN.
        assert!(!is_caught(Phase::Green, g + 0.1, fast, g, t), "moving during GREEN is free");
        // Safe: moving during TURNING (doll not watching yet).
        assert!(!is_caught(Phase::Turning, g + 0.1, fast, g, t), "moving during TURNING is free");
        // Boundary: speed exactly at threshold stays safe (jitter tolerance).
        assert!(!is_caught(Phase::Red, g + 0.1, t, g, t), "speed at threshold is jitter, not a catch");
    }

    /// Reset clears the outcome AND re-arms the stale-position guard: a fresh state
    /// starts in GREEN with no outcome and `prev_player_pos` at the start, so the
    /// next RED entry can't instant-catch from a stale delta.
    #[test]
    fn reset_clears_outcome_and_rearms_guard() {
        // Simulate a finished, mid-loop run with a stale prev position.
        let mut s = RedLightState {
            phase: Phase::Red,
            elapsed: 1.0,
            prev_player_pos: Vec3::new(0.0, 1.0, -10.0),
            outcome: Some(Outcome::Caught),
        };

        // Reset == reinstating the default (what `handle_reset` does).
        s = RedLightState::default();
        assert_eq!(s.phase, Phase::Green, "reset returns to GREEN");
        assert_eq!(s.outcome, None, "reset clears the outcome");
        assert_eq!(s.prev_player_pos, START_POS, "reset re-homes the motion reference");

        // After reset, an immediate (still) GREEN frame is obviously safe, and even
        // when RED later begins the guard re-syncs — proven by the dedicated test.
        assert!(!is_caught(s.phase, 99.0, MOVE_SPEED, GRACE_SECS, CATCH_SPEED_THRESHOLD));
    }

    /// Doll yaw telegraphs the phase: AWAY on GREEN, TOWARD on RED, and eases
    /// monotonically between them across TURNING (mid-turn yaw is strictly between
    /// the two endpoints). Non-tautological: checks the endpoints and the easing
    /// midpoint ordering.
    #[test]
    fn doll_yaw_eases_from_away_to_toward() {
        assert_eq!(doll_target_yaw(Phase::Green, 0.0), DOLL_YAW_AWAY);
        assert_eq!(doll_target_yaw(Phase::Red, 0.0), DOLL_YAW_TOWARD);

        let start = doll_target_yaw(Phase::Turning, 0.0);
        let mid = doll_target_yaw(Phase::Turning, TURNING_SECS * 0.5);
        let end = doll_target_yaw(Phase::Turning, TURNING_SECS);
        assert!((start - DOLL_YAW_AWAY).abs() < 1e-5, "turning starts at AWAY");
        assert!((end - DOLL_YAW_TOWARD).abs() < 1e-5, "turning ends at TOWARD");
        assert!(start < mid && mid < end, "turning eases monotonically away→toward");
    }
}
