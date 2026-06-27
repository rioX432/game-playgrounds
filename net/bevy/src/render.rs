//! `NetRenderPlugin` — the ONLY plugin that needs a GPU/window.
//!
//! Render / net-sim separation (an acceptance criterion): everything here is
//! presentation only. It reads the client-sim's [`InterpTrack`] interpolation
//! buffers and writes each player's `Transform` FROM the interpolated value at
//! `now - interp_delay` — it NEVER replicates or smooths `Transform` directly
//! (the Codex rule). It also maps the keyboard into the [`ClientInput`] resource
//! the client-sim sends. Tests never load this plugin; only the binary does.

use bevy::prelude::*;

use crate::client::{ClientInput, InterpTrack};
use crate::config::{interp_delay_secs, ARENA_HALF, FLAG_FIRING};

/// Visual radius / height of a rendered player capsule, world units (cosmetic;
/// mirrors the web client's `PLAYER_RADIUS` / `PLAYER_HEIGHT`).
const PLAYER_RADIUS: f32 = 0.5;
const PLAYER_HEIGHT: f32 = 1.6;
/// Body + firing-highlight colors (mirror the web client palette).
const COLOR_BODY: Color = Color::srgb(0.69, 0.74, 0.77);
const COLOR_FIRING_EMISSIVE: LinearRgba = LinearRgba::rgb(1.0, 0.44, 0.26);
const NO_EMISSIVE: LinearRgba = LinearRgba::BLACK;

/// Marks a replicated player entity that has had its visual mesh attached, so it
/// is attached exactly once.
#[derive(Component)]
struct PlayerVisual;

/// The render + input layer. Added only by the `--client` binary.
pub struct NetRenderPlugin;

impl Plugin for NetRenderPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(Startup, setup_scene);
        app.add_systems(
            Update,
            (read_keyboard, attach_visuals, update_visuals).chain(),
        );
    }
}

/// Camera + light + a ground reference quad.
fn setup_scene(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    commands.spawn((
        Camera3d::default(),
        Transform::from_xyz(0.0, 28.0, 36.0).looking_at(Vec3::ZERO, Vec3::Y),
    ));
    commands.spawn((
        DirectionalLight {
            illuminance: 8_000.0,
            ..default()
        },
        Transform::from_xyz(10.0, 20.0, 10.0).looking_at(Vec3::ZERO, Vec3::Y),
    ));
    commands.spawn((
        Mesh3d(meshes.add(Plane3d::default().mesh().size(ARENA_HALF * 2.0, ARENA_HALF * 2.0))),
        MeshMaterial3d(materials.add(StandardMaterial {
            base_color: Color::srgb(0.12, 0.13, 0.15),
            ..default()
        })),
        Transform::default(),
    ));
}

/// Keyboard → [`ClientInput`]. WASD / arrows drive the planar axis; Space sets
/// the firing bit (mirrors the web client's `deriveInput`). The axis is
/// normalized so diagonals aren't faster than cardinals.
fn read_keyboard(keys: Res<ButtonInput<KeyCode>>, mut input: ResMut<ClientInput>) {
    let mut x = 0.0_f32;
    let mut y = 0.0_f32;
    if keys.any_pressed([KeyCode::KeyA, KeyCode::ArrowLeft]) {
        x -= 1.0;
    }
    if keys.any_pressed([KeyCode::KeyD, KeyCode::ArrowRight]) {
        x += 1.0;
    }
    if keys.any_pressed([KeyCode::KeyW, KeyCode::ArrowUp]) {
        y -= 1.0;
    }
    if keys.any_pressed([KeyCode::KeyS, KeyCode::ArrowDown]) {
        y += 1.0;
    }
    let len = (x * x + y * y).sqrt();
    if len > 0.0 {
        x /= len;
        y /= len;
    }
    input.move_x = x;
    input.move_y = y;
    input.buttons = if keys.pressed(KeyCode::Space) {
        FLAG_FIRING
    } else {
        0
    };
}

/// Attach a capsule mesh to each replicated player exactly once.
fn attach_visuals(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    fresh: Query<Entity, (With<InterpTrack>, Without<PlayerVisual>)>,
) {
    for entity in &fresh {
        commands.entity(entity).insert((
            PlayerVisual,
            Mesh3d(meshes.add(Capsule3d::new(
                PLAYER_RADIUS,
                PLAYER_HEIGHT - PLAYER_RADIUS * 2.0,
            ))),
            MeshMaterial3d(materials.add(StandardMaterial {
                base_color: COLOR_BODY,
                ..default()
            })),
            Transform::default(),
        ));
    }
}

/// Write each player's `Transform` FROM its interpolation buffer at the delayed
/// render time, and tint the body while the firing flag is set. This is the
/// render-side of "buffer the replicated value, interpolate, then drive render".
fn update_visuals(
    time: Res<Time>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    players: Query<(&InterpTrack, &MeshMaterial3d<StandardMaterial>, &mut Transform), With<PlayerVisual>>,
) {
    let render_time = time.elapsed_secs_f64() - interp_delay_secs();
    for (track, material, mut transform) in players {
        let Some(sample) = track.0.sample_at(render_time) else {
            continue;
        };
        transform.translation = sample.pos + Vec3::Y * (PLAYER_HEIGHT / 2.0);
        if let Some(mat) = materials.get_mut(&material.0) {
            mat.emissive = if sample.flags & FLAG_FIRING != 0 {
                COLOR_FIRING_EMISSIVE
            } else {
                NO_EMISSIVE
            };
        }
    }
}
