//! # s03 — Paint on mesh (runtime-editable texture)
//!
//! **What it demonstrates:** A quad whose `StandardMaterial` uses an `Image` we
//! created at runtime. Left-clicking raycasts onto the quad and stamps a dot
//! into the texture **at the hit UV**, so you literally paint on the surface —
//! the core verb of the "めっちゃカメレオン" disguise/paint idea.
//!
//! **Controls:** `Left Mouse` — paint a dot where the ray hits the quad. `Esc`
//! returns to the menu.
//!
//! **Feel notes:** Writing into `Image.data` and marking the asset changed
//! re-uploads the whole texture each stamp — fine for a 256² demo, but for a
//! real painter you'd want a partial GPU update or a render-to-texture pass.
//! The dot is a filled square here; a soft brush (falloff) feels much better.
//!
//! **Bevy 0.18 gotchas:**
//!   * `Image.data` is `Option<Vec<u8>>` in 0.18 (was `Vec<u8>` in older
//!     versions) — you must `.as_mut()` / handle the `Option`.
//!   * Build the texture with `Image::new_fill(Extent3d, TextureDimension::D2,
//!     &pixel, TextureFormat::Rgba8UnormSrgb, RenderAssetUsages::all())`.
//!     `Extent3d/TextureDimension/TextureFormat` live in
//!     `bevy::render::render_resource`; `RenderAssetUsages` in `bevy::asset`.
//!   * Mutating an asset via `ResMut<Assets<Image>>` + `get_mut` marks it
//!     changed automatically — no manual `Modified` event needed.
//!   * We raycast with rapier (collider on the quad) and recover the UV from
//!     the hit point in the quad's local plane (rapier `cast_ray` gives entity
//!     + toi; we derive UV ourselves).

use bevy::asset::RenderAssetUsages;
use bevy::prelude::*;
use bevy::render::render_resource::{Extent3d, TextureDimension, TextureFormat};
use bevy_rapier3d::prelude::*;

use super::{AppState, SampleMeta};

pub const META: SampleMeta = SampleMeta {
    id: "03-paint-on-mesh",
    title: "Paint on mesh (runtime texture)",
    summary: "Raycast onto a quad and stamp a dot into its texture at the hit UV.",
    tags: &["texture", "paint", "raycast", "rapier"],
};

/// Texture resolution (square).
const TEX_SIZE: u32 = 256;
/// Half-side of the painted dot, in texels.
const BRUSH_RADIUS: i32 = 8;
/// Half-extent of the square quad in world units (so quad spans -HALF..HALF).
const QUAD_HALF: f32 = 2.0;

#[derive(Component)]
struct PaintCamera;

/// Marks the paintable surface and holds the handle to its editable texture.
#[derive(Component)]
struct Paintable {
    image: Handle<Image>,
}

pub struct PaintOnMeshPlugin;

impl Plugin for PaintOnMeshPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(OnEnter(AppState::S03PaintOnMesh), setup)
            .add_systems(
                Update,
                paint_on_click.run_if(in_state(AppState::S03PaintOnMesh)),
            );
    }
}

fn setup(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut images: ResMut<Assets<Image>>,
) {
    let scope = DespawnOnExit(AppState::S03PaintOnMesh);

    // Runtime-created white canvas texture.
    let image = images.add(Image::new_fill(
        Extent3d {
            width: TEX_SIZE,
            height: TEX_SIZE,
            depth_or_array_layers: 1,
        },
        TextureDimension::D2,
        &[230, 230, 230, 255], // light grey so painted dots are visible
        TextureFormat::Rgba8UnormSrgb,
        RenderAssetUsages::all(),
    ));

    // A flat quad facing +Z, standing upright. We give it a cuboid collider
    // (very thin in Z) so rapier can raycast onto it.
    let quad_mesh = meshes.add(Plane3d::default().mesh().size(QUAD_HALF * 2.0, QUAD_HALF * 2.0));

    commands.spawn((
        Paintable {
            image: image.clone(),
        },
        Mesh3d(quad_mesh),
        MeshMaterial3d(materials.add(StandardMaterial {
            base_color_texture: Some(image),
            // Unlit-ish: keep it bright so paint reads clearly under one light.
            perceptual_roughness: 1.0,
            ..default()
        })),
        // `Plane3d` lies in the XZ plane facing +Y. Rotate it to stand upright
        // facing the camera (+Z), so the painted texture faces us.
        Transform::from_xyz(0.0, 0.0, 0.0)
            .with_rotation(Quat::from_rotation_x(std::f32::consts::FRAC_PI_2)),
        RigidBody::Fixed,
        // Thin slab matching the quad in X/Y, tiny in Z (collider is in the
        // body's local frame, before the transform rotation is applied — but
        // because we rotate the whole entity, the collider rotates with it).
        Collider::cuboid(QUAD_HALF, 0.02, QUAD_HALF),
        scope.clone(),
    ));

    commands.spawn((
        PaintCamera,
        Camera3d::default(),
        Transform::from_xyz(0.0, 0.0, 6.0).looking_at(Vec3::ZERO, Vec3::Y),
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
}

/// On click: raycast from the camera; if we hit the paintable, convert the hit
/// world point into the quad's local plane, map to UV, and stamp a dot.
fn paint_on_click(
    buttons: Res<ButtonInput<MouseButton>>,
    rapier: ReadRapierContext,
    mut images: ResMut<Assets<Image>>,
    camera: Query<&GlobalTransform, With<PaintCamera>>,
    paintable: Query<(&Paintable, &GlobalTransform)>,
) {
    if !buttons.just_pressed(MouseButton::Left) {
        return;
    }
    let (Ok(cam), Ok(ctx)) = (camera.single(), rapier.single()) else {
        return;
    };

    let origin = cam.translation();
    let dir = cam.forward().as_vec3();

    let Some((entity, toi)) = ctx.cast_ray(origin, dir, 100.0, true) else {
        return;
    };
    let Ok((paint, surface_xform)) = paintable.get(entity) else {
        return;
    };

    // World-space hit point, then into the quad's local space.
    let hit_world = origin + dir * toi;
    let local = surface_xform
        .affine()
        .inverse()
        .transform_point3(hit_world);

    // The quad (a `Plane3d`) spans -QUAD_HALF..QUAD_HALF in its local X and Z.
    // Map that to [0,1] UV.
    let u = (local.x / (QUAD_HALF * 2.0)) + 0.5;
    let v = (local.z / (QUAD_HALF * 2.0)) + 0.5;
    if !(0.0..=1.0).contains(&u) || !(0.0..=1.0).contains(&v) {
        return;
    }

    if let Some(image) = images.get_mut(&paint.image) {
        stamp_dot(image, u, v);
    }
}

/// Writes a filled red square of `BRUSH_RADIUS` texels around (u,v) into the
/// RGBA8 image data.
fn stamp_dot(image: &mut Image, u: f32, v: f32) {
    let w = image.texture_descriptor.size.width as i32;
    let h = image.texture_descriptor.size.height as i32;
    let Some(data) = image.data.as_mut() else {
        return;
    };

    let cx = (u * w as f32) as i32;
    let cy = (v * h as f32) as i32;

    for dy in -BRUSH_RADIUS..=BRUSH_RADIUS {
        for dx in -BRUSH_RADIUS..=BRUSH_RADIUS {
            let x = cx + dx;
            let y = cy + dy;
            if x < 0 || y < 0 || x >= w || y >= h {
                continue;
            }
            let idx = ((y * w + x) * 4) as usize;
            if idx + 3 < data.len() {
                data[idx] = 220; // R
                data[idx + 1] = 40; // G
                data[idx + 2] = 40; // B
                data[idx + 3] = 255; // A
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Headless proof that `stamp_dot` mutates the texture's center pixel.
    #[test]
    fn stamp_dot_writes_center_pixel() {
        let mut image = Image::new_fill(
            Extent3d {
                width: TEX_SIZE,
                height: TEX_SIZE,
                depth_or_array_layers: 1,
            },
            TextureDimension::D2,
            &[230, 230, 230, 255],
            TextureFormat::Rgba8UnormSrgb,
            RenderAssetUsages::all(),
        );

        stamp_dot(&mut image, 0.5, 0.5);

        let w = TEX_SIZE as usize;
        let center = ((TEX_SIZE / 2) as usize * w + (TEX_SIZE / 2) as usize) * 4;
        let data = image.data.as_ref().unwrap();
        assert_eq!(data[center], 220, "center R should be painted red");
        assert_eq!(data[center + 1], 40, "center G should be painted");
    }
}
