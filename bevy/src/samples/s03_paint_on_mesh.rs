//! # s03 — Paint on mesh (runtime-editable texture)
//!
//! **What it demonstrates:** A sphere whose `StandardMaterial` uses an `Image` we
//! created at runtime. **Dragging** the mouse raycasts the cursor onto the sphere
//! and stamps a round brush into the texture **at the hit UV**, so you literally
//! paint on the curved surface — the core verb of the "paint-to-disguise" idea.
//! A 6-swatch palette (number keys) picks the brush color, and the sphere slowly
//! auto-rotates so the far side is reachable. This matches the Three.js /
//! Babylon.js `03` peers (sphere + palette + drag) rather than a flat one-color
//! quad.
//!
//! **Controls:** `Left Mouse` (hold + drag) — paint. `1`–`6` — pick a palette
//! color. `R` — toggle auto-rotate. `Esc` returns to the menu.
//!
//! **Feel notes:** Writing into `Image.data` and marking the asset changed
//! re-uploads the whole texture each stamp — fine for a 256² demo, but a real
//! painter would want a partial GPU update or render-to-texture. The brush is a
//! filled disc (hard edge); a soft falloff feels better. A UV sphere distorts
//! badly near its poles (all longitude sectors converge), so strokes smear there
//! — we orient the poles to world up/down so the camera mostly sees the
//! low-distortion equator band, the same trick the Three.js peer relies on.
//!
//! **Bevy 0.18 gotchas:**
//!   * `Image.data` is `Option<Vec<u8>>` in 0.18 (was `Vec<u8>`) — handle the
//!     `Option`.
//!   * Build the texture with `Image::new_fill(Extent3d, TextureDimension::D2,
//!     &pixel, TextureFormat::Rgba8UnormSrgb, RenderAssetUsages::all())`.
//!     `Extent3d/TextureDimension/TextureFormat` live in
//!     `bevy::render::render_resource`; `RenderAssetUsages` in `bevy::asset`.
//!   * Mutating an asset via `ResMut<Assets<Image>>` + `get_mut` marks it changed
//!     automatically — no manual event needed.
//!   * Use a **UV sphere** (`Sphere::new(r).mesh().uv(sectors, stacks)`), NOT the
//!     default icosphere: only the UV sphere has the analytic lat/long mapping we
//!     invert in [`sphere_uv`] (poles on local +Z, `u = j/sectors`, `v =
//!     i/stacks`, per `bevy_mesh`'s songho-derived generator). The icosphere's
//!     UVs can't be recovered from a hit point.
//!   * Painting needs the absolute cursor, so (like s11) we set
//!     `PointerLock.locked = true` to make the shared grabber stand down and run
//!     [`free_cursor`] each frame; cursor→ray via `Camera::viewport_to_world`.

use bevy::asset::RenderAssetUsages;
use bevy::prelude::*;
use bevy::render::render_resource::{Extent3d, TextureDimension, TextureFormat};
use bevy::window::{CursorGrabMode, CursorOptions, PrimaryWindow};
use bevy_rapier3d::prelude::*;
use std::f32::consts::{FRAC_PI_2, PI};

use crate::engine::hud;
use crate::engine::input::PointerLock;

use super::{AppState, SampleMeta};

pub const META: SampleMeta = SampleMeta {
    id: "03-paint-on-mesh",
    title: "Paint on mesh (runtime texture)",
    summary: "Drag to paint a sphere's runtime texture at the hit UV; palette + auto-rotate.",
    tags: &["texture", "paint", "raycast", "rapier"],
};

/// Texture resolution (square).
const TEX_SIZE: u32 = 256;
/// Radius of the round brush, in texels.
const BRUSH_RADIUS: i32 = 10;
/// Sphere radius in world units.
const SPHERE_RADIUS: f32 = 1.5;
/// Auto-rotate speed (radians / second) about world up.
const AUTOROTATE_SPEED: f32 = 0.3;
/// Base canvas color (light grey, so painted strokes read clearly).
const BASE_PIXEL: [u8; 4] = [230, 230, 230, 255];
/// Brush palette (RGBA), mirroring the Three.js peer's swatches. Picked with the
/// number keys `1`..=`6`.
const PALETTE: [[u8; 4]; 6] = [
    [255, 59, 48, 255],  // red
    [52, 199, 89, 255],  // green
    [10, 132, 255, 255], // blue
    [255, 214, 10, 255], // yellow
    [255, 45, 146, 255], // pink
    [0, 0, 0, 255],      // black
];

#[derive(Component)]
struct PaintCamera;

/// Marks the paintable surface and holds the handle to its editable texture.
#[derive(Component)]
struct Paintable {
    image: Handle<Image>,
}

/// Brush color + auto-rotate toggle. A `Resource`, so it is reset on every
/// `OnEnter` (resources survive `DespawnOnExit`).
#[derive(Resource)]
struct PaintState {
    color: [u8; 4],
    autorotate: bool,
}

impl Default for PaintState {
    fn default() -> Self {
        Self {
            color: PALETTE[0],
            autorotate: true,
        }
    }
}

pub struct PaintOnMeshPlugin;

impl Plugin for PaintOnMeshPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(OnEnter(AppState::S03PaintOnMesh), setup).add_systems(
            Update,
            (free_cursor, select_color, toggle_autorotate, autorotate_sphere, paint)
                .run_if(in_state(AppState::S03PaintOnMesh)),
        );
    }
}

fn setup(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut images: ResMut<Assets<Image>>,
    mut pointer: ResMut<PointerLock>,
) {
    let state = AppState::S03PaintOnMesh;
    let scope = DespawnOnExit(state);

    // Reset brush state on entry (resources survive DespawnOnExit).
    commands.insert_resource(PaintState::default());

    // Free the cursor: tell the shared grabber to stand down (see s11). The
    // shared `release_input` resets this on Menu exit.
    pointer.locked = true;

    // Runtime-created light-grey canvas texture.
    let image = images.add(Image::new_fill(
        Extent3d {
            width: TEX_SIZE,
            height: TEX_SIZE,
            depth_or_array_layers: 1,
        },
        TextureDimension::D2,
        &BASE_PIXEL,
        TextureFormat::Rgba8UnormSrgb,
        RenderAssetUsages::all(),
    ));

    // UV sphere (NOT the default icosphere — we need the invertible UV mapping).
    let sphere_mesh = meshes.add(Sphere::new(SPHERE_RADIUS).mesh().uv(32, 18));

    commands.spawn((
        Paintable {
            image: image.clone(),
        },
        Mesh3d(sphere_mesh),
        MeshMaterial3d(materials.add(StandardMaterial {
            base_color_texture: Some(image),
            perceptual_roughness: 0.8,
            metallic: 0.0,
            ..default()
        })),
        // The UV sphere's poles are on its local +Z; rotate so they point to
        // world up/down, leaving the low-distortion equator band facing the
        // camera. `sphere_uv` works in local space, so this rotation (and the
        // auto-rotation) are transparently handled via the inverse transform.
        Transform::from_rotation(Quat::from_rotation_x(FRAC_PI_2)),
        RigidBody::Fixed,
        Collider::ball(SPHERE_RADIUS),
        scope.clone(),
    ));

    commands.spawn((
        PaintCamera,
        Camera3d::default(),
        Transform::from_xyz(0.0, 0.0, 5.0).looking_at(Vec3::ZERO, Vec3::Y),
        scope.clone(),
    ));

    commands.spawn((
        DirectionalLight {
            illuminance: 8_000.0,
            ..default()
        },
        Transform::from_xyz(2.0, 4.0, 6.0).looking_at(Vec3::ZERO, Vec3::Y),
        scope,
    ));

    hud::spawn_controls_overlay(
        &mut commands,
        state,
        &[
            "Drag — paint",
            "1-6 — pick color",
            "R — toggle auto-rotate",
            "Esc — back to menu",
        ],
    );
}

/// Keeps the OS cursor FREE (visible + ungrabbed) every frame, overriding the
/// shared auto-grab — painting needs the absolute cursor. Mirrors s11.
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

/// Number keys `1`..=`6` select the brush color from [`PALETTE`].
fn select_color(keyboard: Res<ButtonInput<KeyCode>>, mut state: ResMut<PaintState>) {
    const KEYS: [KeyCode; 6] = [
        KeyCode::Digit1,
        KeyCode::Digit2,
        KeyCode::Digit3,
        KeyCode::Digit4,
        KeyCode::Digit5,
        KeyCode::Digit6,
    ];
    for (i, key) in KEYS.iter().enumerate() {
        if keyboard.just_pressed(*key) {
            state.color = PALETTE[i];
        }
    }
}

/// `R` toggles the idle auto-rotation.
fn toggle_autorotate(keyboard: Res<ButtonInput<KeyCode>>, mut state: ResMut<PaintState>) {
    if keyboard.just_pressed(KeyCode::KeyR) {
        state.autorotate = !state.autorotate;
    }
}

/// Slowly spins the sphere about world up while enabled and not actively
/// painting, so the unpainted far side becomes reachable (mirrors the peer).
fn autorotate_sphere(
    time: Res<Time>,
    state: Res<PaintState>,
    buttons: Res<ButtonInput<MouseButton>>,
    mut paintable: Query<&mut Transform, With<Paintable>>,
) {
    if !state.autorotate || buttons.pressed(MouseButton::Left) {
        return;
    }
    let Ok(mut transform) = paintable.single_mut() else {
        return;
    };
    transform.rotate_axis(Dir3::Y, AUTOROTATE_SPEED * time.delta_secs());
}

/// While the left button is held, raycast the cursor onto the sphere and stamp a
/// brush dot at the hit UV. Holding (not just-pressed) gives continuous strokes.
fn paint(
    buttons: Res<ButtonInput<MouseButton>>,
    state: Res<PaintState>,
    rapier: ReadRapierContext,
    mut images: ResMut<Assets<Image>>,
    window_query: Query<&Window, With<PrimaryWindow>>,
    camera: Query<(&Camera, &GlobalTransform), With<PaintCamera>>,
    paintable: Query<(&Paintable, &GlobalTransform)>,
) {
    if !buttons.pressed(MouseButton::Left) {
        return;
    }
    let (Ok(window), Ok((camera, cam_xform)), Ok(ctx)) =
        (window_query.single(), camera.single(), rapier.single())
    else {
        return;
    };
    let Some(cursor_pos) = window.cursor_position() else {
        return;
    };
    let Ok(ray) = camera.viewport_to_world(cam_xform, cursor_pos) else {
        return;
    };

    let Some((entity, toi)) =
        ctx.cast_ray(ray.origin, ray.direction.as_vec3(), 100.0, true, QueryFilter::default())
    else {
        return;
    };
    let Ok((paint, surface_xform)) = paintable.get(entity) else {
        return;
    };

    // World hit point -> the sphere's local space -> UV.
    let hit_world = ray.get_point(toi);
    let local = surface_xform.affine().inverse().transform_point3(hit_world);
    let (u, v) = sphere_uv(local);

    if let Some(image) = images.get_mut(&paint.image) {
        stamp_dot(image, u, v, state.color);
    }
}

/// Inverse of `bevy_mesh`'s UV-sphere mapping: given a point on the sphere in its
/// LOCAL frame, recover `(u, v)` in `[0,1]`. The generator places poles on local
/// +Z with `u = sector_angle / 2π` (`sector_angle = atan2(y, x)`) and `v =
/// acos(z) / π`. Pure, so the mapping is unit-tested without a window.
fn sphere_uv(point: Vec3) -> (f32, f32) {
    let n = point.normalize_or_zero();
    let mut u = n.y.atan2(n.x) / (2.0 * PI);
    if u < 0.0 {
        u += 1.0; // atan2 is (-π,π]; wrap the seam into [0,1)
    }
    let v = n.z.clamp(-1.0, 1.0).acos() / PI;
    (u, v)
}

/// Writes a filled disc of [`BRUSH_RADIUS`] texels in `color` around (u,v) into
/// the RGBA8 image data. wgpu UV origin is top-left, so `v` maps straight to the
/// row (no flip).
fn stamp_dot(image: &mut Image, u: f32, v: f32, color: [u8; 4]) {
    let w = image.texture_descriptor.size.width as i32;
    let h = image.texture_descriptor.size.height as i32;
    let Some(data) = image.data.as_mut() else {
        return;
    };

    let cx = (u * w as f32) as i32;
    let cy = (v * h as f32) as i32;
    let r2 = BRUSH_RADIUS * BRUSH_RADIUS;

    for dy in -BRUSH_RADIUS..=BRUSH_RADIUS {
        for dx in -BRUSH_RADIUS..=BRUSH_RADIUS {
            if dx * dx + dy * dy > r2 {
                continue; // round brush
            }
            let x = cx + dx;
            let y = cy + dy;
            if x < 0 || y < 0 || x >= w || y >= h {
                continue;
            }
            let idx = ((y * w + x) * 4) as usize;
            if idx + 3 < data.len() {
                data[idx..idx + 4].copy_from_slice(&color);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blank() -> Image {
        Image::new_fill(
            Extent3d {
                width: TEX_SIZE,
                height: TEX_SIZE,
                depth_or_array_layers: 1,
            },
            TextureDimension::D2,
            &BASE_PIXEL,
            TextureFormat::Rgba8UnormSrgb,
            RenderAssetUsages::all(),
        )
    }

    /// `stamp_dot` paints the chosen color at the center, leaves a far corner of
    /// the brush's bounding box untouched (proving the brush is round, not a
    /// square).
    #[test]
    fn stamp_dot_paints_round_in_color() {
        let mut image = blank();
        let color = PALETTE[2]; // blue
        stamp_dot(&mut image, 0.5, 0.5, color);

        let w = TEX_SIZE as i32;
        let cx = (0.5 * w as f32) as i32;
        let cy = (0.5 * w as f32) as i32;
        let at = |x: i32, y: i32| {
            let i = ((y * w + x) * 4) as usize;
            let d = image.data.as_ref().unwrap();
            [d[i], d[i + 1], d[i + 2], d[i + 3]]
        };

        assert_eq!(at(cx, cy), color, "center should be painted in the brush color");
        // A corner of the (2R x 2R) bounding box is outside the disc => unpainted.
        assert_eq!(
            at(cx + BRUSH_RADIUS, cy + BRUSH_RADIUS),
            BASE_PIXEL,
            "the bounding-box corner is outside the round brush and must stay base color"
        );
    }

    /// `sphere_uv` inverts the known generator anchors (poles on local ±Z, seam
    /// on +X, quarter-turn on +Y).
    #[test]
    fn sphere_uv_matches_generator_anchors() {
        let approx = |a: f32, b: f32| (a - b).abs() < 1e-5;

        // +Z pole -> v = 0.
        let (_, v_top) = sphere_uv(Vec3::Z);
        assert!(approx(v_top, 0.0), "v_top={v_top}");
        // -Z pole -> v = 1.
        let (_, v_bot) = sphere_uv(Vec3::NEG_Z);
        assert!(approx(v_bot, 1.0), "v_bot={v_bot}");
        // Equator on +X -> u = 0 (seam), v = 0.5.
        let (u_x, v_x) = sphere_uv(Vec3::X);
        assert!(approx(u_x, 0.0) && approx(v_x, 0.5), "u_x={u_x} v_x={v_x}");
        // Equator on +Y -> a quarter turn (u = 0.25), v = 0.5.
        let (u_y, v_y) = sphere_uv(Vec3::Y);
        assert!(approx(u_y, 0.25) && approx(v_y, 0.5), "u_y={u_y} v_y={v_y}");
    }
}
