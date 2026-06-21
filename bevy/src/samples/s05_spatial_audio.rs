//! # s05 — Spatial audio (proximity falloff)
//!
//! **What it demonstrates:** Positional audio with distance attenuation — a
//! proximity-voice stand-in (REPO / Content Warning style). Three procedurally
//! generated beacon tones (distinct pitches) sit in the world; as the
//! first-person player walks nearer/farther, each beacon's volume attenuates by
//! the listener↔emitter distance. The sound is generated in-code (no asset
//! files) via a custom `Decodable` audio source — a looping sine implementing
//! rodio's `Source` + `Iterator<Item = f32>`, registered with
//! `add_audio_source`. Falloff is driven by an explicit, unit-tested pure
//! curve [`proximity_gain`] rather than relying on the engine's spatial scale,
//! so the proximity→volume relationship is legible and verifiable headless.
//!
//! **Controls:** Click to lock the mouse. `W/A/S/D` move (yaw-relative).
//! `Mouse` looks. `Space` jumps. `Esc` returns to the menu (which releases the
//! cursor and despawns every emitter — stopping its sink, so audio stops with
//! no manual teardown). The HUD shows the nearest beacon's distance + gain.
//!
//! **Feel notes:** Walking toward a beacon and hearing it swell, then fade as
//! you pass it, reads convincingly as a proximity voice — the distinct pitches
//! make it obvious *which* emitter is near. The first-person movement is reused
//! verbatim from s04, so it feels the same arcade-stiff way (instant
//! accel/decel, no head-bob, you clip through the boxes). Honest bad parts:
//! (1) attenuation here is **mono volume only** — there is no stereo panning or
//! occlusion, so a beacon to your left and one to your right sound identical
//! when equidistant; direction is invisible (a real proximity-voice game pans
//! and muffles through walls). (2) The raw sine is a harsh, buzzy test tone, not
//! a pleasant voice — fine for verifying falloff, unpleasant to sit in.
//! (3) Because gain is set per-frame from distance with no smoothing, fast
//! strafing past a beacon can make the volume "zip" rather than glide. (4) All
//! beacons play from frame zero at once, so at the spawn point you hear a chord
//! of three tones until you move and they separate by distance.
//!
//! **Spatial vs manual-volume choice:** Bevy *does* offer engine spatial audio
//! (`SpatialListener` on the camera + `PlaybackSettings::LOOP.with_spatial(true)`
//! on the emitter, attenuating by listener distance with stereo panning). We
//! deliberately drive `AudioSink` volume manually from our own
//! [`proximity_gain`] curve instead: it makes the falloff law explicit and
//! unit-testable (the engine's `spatial_scale` default makes falloff subtle and
//! opaque), at the documented cost of losing the engine's stereo panning. The
//! mechanic under test is *distance attenuation*, which this curve nails.
//!
//! **Autoplay note (vs the web siblings):** native Bevy audio needs **no user
//! gesture** — the beacons start the instant the sample is entered. The
//! `../three` / `../babylon` WebAudio siblings must wait for a first click to
//! resume a suspended `AudioContext`; here the click only locks the mouse.
//!
//! **Bevy 0.18 gotchas:**
//!   * Custom audio source: implement `Decodable` on an `Asset` whose `Decoder`
//!     is a `rodio::Source` + `Iterator<Item = f32>`; register it ONCE with
//!     `app.add_audio_source::<BeaconTone>()` in the plugin's `build` (NOT in a
//!     per-`OnEnter` system — that would re-register every entry). rodio is
//!     re-exported under `bevy::audio`.
//!   * rodio 0.20's `Source` requires `current_frame_len`/`channels`/
//!     `sample_rate`/`total_duration`; an endless looping tone returns `None`
//!     for the two length/duration methods.
//!   * `AudioSink::set_volume` takes `&mut self` in 0.18 (was `&self`), so the
//!     driver query is `Query<&mut AudioSink>`, and volume is a
//!     `Volume::Linear(..)` — not a bare `f32`.
//!   * Play a generated tone with `AudioPlayer(handle)` +
//!     `PlaybackSettings::LOOP`; the handle comes from `Assets<BeaconTone>`.
//!   * `DespawnOnExit(state)` on each emitter despawns it on exit, which stops
//!     its sink — that IS the audio teardown (no global audio resource leaks).
//!   * Time delta is `time.delta_secs()` (f32); `Query::single_mut()` returns
//!     `Result` — handle with `let Ok(..) = .. else`.

use bevy::audio::{AddAudioSource, Source, Volume};
use bevy::prelude::*;
use bevy::reflect::TypePath;
use core::time::Duration;

use crate::engine::hud::{self, FpsText};
use crate::engine::input::{LookState, MoveIntent};
use crate::engine::scene;

use super::{AppState, SampleMeta};

pub const META: SampleMeta = SampleMeta {
    id: "05-spatial-audio",
    title: "Spatial audio (proximity falloff)",
    summary: "Procedural beacon tones whose volume attenuates with first-person distance.",
    tags: &["audio", "spatial", "proximity", "first-person"],
};

// --- First-person movement (reused from s04) ---------------------------------

/// Horizontal movement speed (world units / second).
const MOVE_SPEED: f32 = 6.0;
/// Eye height above the floor (world units) — the camera's resting Y.
const EYE_HEIGHT: f32 = 1.7;
/// Gravity acceleration (world units / second^2), pulling the eye down.
const GRAVITY: f32 = -20.0;
/// Upward velocity imparted by a jump (world units / second).
const JUMP_SPEED: f32 = 7.0;

// --- Proximity attenuation curve ---------------------------------------------

/// At or below this distance (world units) a beacon plays at full volume.
const REF_DISTANCE: f32 = 1.5;
/// At or beyond this distance (world units) a beacon is fully silent.
const MAX_DISTANCE: f32 = 16.0;
/// Curve shape: 1.0 = linear falloff; >1 front-loads loudness near the emitter
/// (quieter sooner as you back away), which reads as a tighter "voice bubble".
const ROLLOFF: f32 = 2.0;

/// Pure proximity→gain law: full gain inside [`REF_DISTANCE`], zero at/after
/// [`MAX_DISTANCE`], and a smooth `ROLLOFF`-shaped falloff between. Returns a
/// linear gain in `[0.0, 1.0]`.
///
/// Extracted (no ECS / no audio device) so headless tests can assert the
/// attenuation mechanic without a GPU or audio backend — `MinimalPlugins` has
/// no audio. This is the single source of truth fed into the live `AudioSink`
/// volume each frame, so testing it tests the real falloff.
fn proximity_gain(distance: f32) -> f32 {
    if distance <= REF_DISTANCE {
        return 1.0;
    }
    if distance >= MAX_DISTANCE {
        return 0.0;
    }
    // Normalize the [REF, MAX] band to [0, 1], invert (near = 1), shape by rolloff.
    let t = (distance - REF_DISTANCE) / (MAX_DISTANCE - REF_DISTANCE);
    (1.0 - t).powf(ROLLOFF)
}

// --- Procedural looping sine audio source ------------------------------------

/// Audio output sample rate (Hz) for the generated tones.
const SAMPLE_RATE: u32 = 44_100;

/// A procedurally generated, endlessly looping sine tone. This is the custom
/// audio "asset" — no sound files (the playground forbids bespoke art assets).
/// One per beacon, each at a distinct [`frequency`](Self::frequency) so the ear
/// can tell which emitter it's near.
#[derive(Asset, TypePath)]
struct BeaconTone {
    /// Tone frequency in Hz.
    frequency: f32,
}

/// The rodio decoder for [`BeaconTone`]: yields an unending stream of sine
/// samples. Implements `Iterator<Item = f32>` (the samples) + `Source` (stream
/// metadata) as bevy's `Decodable` requires.
struct BeaconDecoder {
    /// Phase accumulator in turns (`[0, 1)`), advanced each sample.
    progress: f32,
    /// Phase advance per sample = frequency / sample_rate (turns per sample).
    step_per_sample: f32,
    /// Full-circle constant (2π) used to convert turns → radians for `sin`.
    two_pi: f32,
    /// Output sample rate (Hz).
    sample_rate: u32,
}

impl BeaconDecoder {
    fn new(frequency: f32) -> Self {
        BeaconDecoder {
            progress: 0.0,
            step_per_sample: frequency / SAMPLE_RATE as f32,
            two_pi: std::f32::consts::PI * 2.0,
            sample_rate: SAMPLE_RATE,
        }
    }
}

impl Iterator for BeaconDecoder {
    type Item = f32;

    fn next(&mut self) -> Option<Self::Item> {
        self.progress = (self.progress + self.step_per_sample) % 1.0;
        Some((self.two_pi * self.progress).sin())
    }
}

impl Source for BeaconDecoder {
    fn current_frame_len(&self) -> Option<usize> {
        None
    }

    fn channels(&self) -> u16 {
        1
    }

    fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    fn total_duration(&self) -> Option<Duration> {
        // Endless tone — no finite duration. Looping is handled by PlaybackSettings.
        None
    }
}

impl Decodable for BeaconTone {
    type DecoderItem = <BeaconDecoder as Iterator>::Item;
    type Decoder = BeaconDecoder;

    fn decoder(&self) -> Self::Decoder {
        BeaconDecoder::new(self.frequency)
    }
}

// --- Sample components & layout ----------------------------------------------

/// The first-person eye (camera). Holds kinematic vertical velocity; horizontal
/// motion is stateless (driven from [`MoveIntent`]). Mirrors s04's `Eye`.
#[derive(Component, Default)]
struct Eye {
    /// Current vertical velocity (world units / second). `0` while grounded.
    vertical_velocity: f32,
}

/// A proximity beacon: a visible marker whose `AudioSink` volume is driven each
/// frame from the player distance via [`proximity_gain`].
#[derive(Component)]
struct Beacon;

/// One beacon's world position (XZ) and tone frequency (Hz).
struct BeaconSpec {
    position: Vec3,
    frequency: f32,
}

/// Marker radius (world units) for the small emitter sphere.
const BEACON_RADIUS: f32 = 0.4;
/// Beacon marker height above the ground (world units).
const BEACON_HEIGHT: f32 = 1.0;

/// The three beacons: spread out so the player must walk between them, each a
/// distinct musical-ish pitch (A3 / C#5 / A5) to keep them aurally separable.
fn beacon_specs() -> [BeaconSpec; 3] {
    [
        BeaconSpec {
            position: Vec3::new(-6.0, BEACON_HEIGHT, -4.0),
            frequency: 220.0,
        },
        BeaconSpec {
            position: Vec3::new(6.0, BEACON_HEIGHT, -4.0),
            frequency: 554.0,
        },
        BeaconSpec {
            position: Vec3::new(0.0, BEACON_HEIGHT, -10.0),
            frequency: 880.0,
        },
    ]
}

pub struct SpatialAudioPlugin;

impl Plugin for SpatialAudioPlugin {
    fn build(&self, app: &mut App) {
        // Register the custom procedural audio source ONCE (not per-OnEnter).
        app.add_audio_source::<BeaconTone>()
            .add_systems(OnEnter(AppState::S05SpatialAudio), setup)
            .add_systems(
                Update,
                (aim_eye, move_eye, apply_gravity_and_jump, drive_proximity_volume)
                    .chain()
                    .run_if(in_state(AppState::S05SpatialAudio)),
            );
    }
}

fn setup(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut tones: ResMut<Assets<BeaconTone>>,
) {
    let state = AppState::S05SpatialAudio;

    // Shared scene primitives (each DespawnOnExit-scoped internally).
    scene::spawn_ground(&mut commands, &mut meshes, &mut materials, state);
    scene::spawn_light_preset(&mut commands, state);

    // A glowing marker mesh shared across beacons.
    let beacon_mesh = meshes.add(Sphere::new(BEACON_RADIUS));
    let beacon_material = materials.add(StandardMaterial {
        base_color: Color::srgb(0.2, 0.7, 1.0),
        emissive: LinearRgba::rgb(0.1, 0.4, 0.8),
        ..default()
    });

    // Each beacon: a marker + a looping procedural tone played at zero volume to
    // start (the per-frame driver raises it by proximity). DespawnOnExit stops
    // the sink on exit — that is the audio teardown.
    for spec in beacon_specs() {
        let handle = tones.add(BeaconTone {
            frequency: spec.frequency,
        });
        commands.spawn((
            Beacon,
            Mesh3d(beacon_mesh.clone()),
            MeshMaterial3d(beacon_material.clone()),
            Transform::from_translation(spec.position),
            AudioPlayer(handle),
            PlaybackSettings::LOOP.with_volume(Volume::Linear(0.0)),
            DespawnOnExit(state),
        ));
    }

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
            "Walk near a beacon — it gets louder",
            "Esc — back to menu",
        ],
    );
    hud::spawn_fps_counter(&mut commands, state);
}

/// Orients the eye from the shared [`LookState`] (reused from s04).
fn aim_eye(look: Res<LookState>, mut query: Query<&mut Transform, With<Eye>>) {
    let Ok(mut transform) = query.single_mut() else {
        return;
    };
    transform.rotation = Quat::from_euler(EulerRot::YXZ, look.yaw, look.pitch, 0.0);
}

/// Moves the eye horizontally from yaw-relative [`MoveIntent`] (reused from s04).
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
    let world_dir = Quat::from_rotation_y(look.yaw) * intent.dir;
    transform.translation += world_dir * MOVE_SPEED * time.delta_secs();
}

/// Kinematic gravity + jump on the eye's Y (reused from s04).
fn apply_gravity_and_jump(
    time: Res<Time>,
    keyboard: Res<ButtonInput<KeyCode>>,
    mut query: Query<(&mut Transform, &mut Eye)>,
) {
    let Ok((mut transform, mut eye)) = query.single_mut() else {
        return;
    };
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

/// Pure one-step vertical integrator (reused from s04): edge-triggered jump
/// while grounded, gravity over `dt`, snap to the floor at [`EYE_HEIGHT`].
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

/// THE proximity mechanic: each frame, set every beacon's `AudioSink` volume
/// from its distance to the eye via the pure [`proximity_gain`] curve, and write
/// the nearest beacon's distance/gain into the FPS HUD line for legibility.
///
/// The `AudioSink` only exists once Bevy has started playback (a frame or two
/// after spawn), so this no-ops gracefully until then.
fn drive_proximity_volume(
    eye_query: Query<&Transform, With<Eye>>,
    mut beacons: Query<(&Transform, &mut AudioSink), With<Beacon>>,
    mut hud_text: Query<&mut Text, With<FpsText>>,
) {
    let Ok(eye) = eye_query.single() else {
        return;
    };
    let eye_pos = eye.translation;

    let mut nearest: Option<(f32, f32)> = None; // (distance, gain)
    for (transform, mut sink) in &mut beacons {
        let distance = transform.translation.distance(eye_pos);
        let gain = proximity_gain(distance);
        sink.set_volume(Volume::Linear(gain));
        if nearest.is_none_or(|(d, _)| distance < d) {
            nearest = Some((distance, gain));
        }
    }

    if let (Some((distance, gain)), Ok(mut text)) = (nearest, hud_text.single_mut()) {
        **text = format!("nearest beacon: {distance:.1}m  gain {gain:.2}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The attenuation mechanic: gain is full at the emitter, monotonically
    /// decreases with distance, and is silent at/after the max distance. This is
    /// the live falloff curve fed into the AudioSink, proven without an audio
    /// device (MinimalPlugins has no audio backend).
    #[test]
    fn proximity_gain_falls_off_with_distance() {
        // Full volume at and within the reference distance.
        assert_eq!(proximity_gain(0.0), 1.0, "zero distance must be full gain");
        assert_eq!(
            proximity_gain(REF_DISTANCE),
            1.0,
            "at the reference distance gain is still full"
        );

        // Strictly decreasing across the falloff band.
        let near = proximity_gain(REF_DISTANCE + 1.0);
        let far = proximity_gain(MAX_DISTANCE - 1.0);
        assert!(near > far, "nearer must be louder: near={near} far={far}");
        assert!(
            near > 0.0 && near < 1.0,
            "mid-band gain must be strictly between 0 and 1, got {near}"
        );

        // Silent at and beyond the max distance.
        assert_eq!(
            proximity_gain(MAX_DISTANCE),
            0.0,
            "at the max distance gain must be zero"
        );
        assert_eq!(
            proximity_gain(MAX_DISTANCE + 100.0),
            0.0,
            "beyond the max distance gain stays zero (no negative/NaN)"
        );
    }

    /// The procedural decoder produces a bounded, non-trivial sine stream: every
    /// sample is in `[-1, 1]` and the tone actually oscillates (not a constant),
    /// proving the custom audio source generates real waveform data.
    #[test]
    fn beacon_decoder_yields_bounded_oscillating_samples() {
        let mut decoder = BeaconDecoder::new(440.0);
        let samples: Vec<f32> = (0..512).map(|_| decoder.next().unwrap()).collect();

        for s in &samples {
            assert!(
                (-1.0..=1.0).contains(s),
                "sine samples must stay within [-1, 1], got {s}"
            );
        }
        let min = samples.iter().cloned().fold(f32::INFINITY, f32::min);
        let max = samples.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
        assert!(
            max - min > 1.0,
            "the tone must oscillate meaningfully, span was {}",
            max - min
        );
    }

    /// Three beacons with distinct frequencies (so proximity tells them apart).
    #[test]
    fn beacons_have_distinct_frequencies() {
        let specs = beacon_specs();
        let freqs: Vec<f32> = specs.iter().map(|s| s.frequency).collect();
        for (i, a) in freqs.iter().enumerate() {
            for b in &freqs[i + 1..] {
                assert!(
                    (a - b).abs() > f32::EPSILON,
                    "beacon frequencies must be distinct, found {a} == {b}"
                );
            }
        }
    }
}
