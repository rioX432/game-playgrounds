//! # s12 — Spherical gravity + walk-on-sphere (Messenger-style tiny planet)
//!
//! **What it demonstrates:** A "tiny planet" where gravity always pulls toward a
//! sphere's center and the player's local *up* aligns to the surface normal, so
//! you can walk all the way around the globe — over the top, around the side, and
//! across the underside — without ever "falling off". Pure kinematic math (NO
//! physics engine): the player position is re-projected onto the sphere every
//! frame and a stable tangent basis is carried frame-to-frame. Scattered
//! **scenery props** (cones + boxes) are placed ON the surface and oriented so
//! their local +Y is the *surface normal* at their spot — they stick out
//! radially like trees on a tiny planet (at the equator, near both poles, and on
//! the underside), not all pointing world-up. A **polished follow camera** rides
//! behind the player and damps its position AND its up toward the surface normal
//! frame-rate-independently, so turning around the globe feels smooth and the
//! curved horizon stays readable. (12a was the core controller; #42 / "12b"
//! added the props + the polished camera; the camera math is the separable
//! [`damp_camera`] helper driven from [`update_camera`].)
//!
//! **Controls (tank-style, deliberately legible):** `A/D` turn the heading
//! (yaw around the local up), `W/S` walk forward/back along the tangent plane,
//! `Space` jumps radially outward. `Esc` returns to the menu. Tank controls were
//! chosen over mouse-look because on a curved surface the heading *is* the player
//! state we want to make visible — you can watch the basis tilt as you round the
//! globe. (Mouse-look would hide that behind the camera.)
//!
//! **Feel notes:** Walking up and over the pole genuinely feels like a tiny
//! planet — the moment your feet pass the top and the world rolls "down" the far
//! side is the payoff. The scenery props are what *sell* it: with a bare sphere
//! you cannot tell you are moving or rotating, but watching a cone on the horizon
//! swing radially as you round the globe gives the curvature real weight, and the
//! props near the underside reassure you the whole sphere is walkable. The
//! smoothed camera is a clear upgrade over the old snap-every-frame follow:
//! position and horizon now ease into turns instead of locking instantly, so
//! `A/D` reads far less robotic even though the underlying turn is still
//! constant-rate. Honest bad parts: tank turning still has no input acceleration,
//! so the *intent* is arcade-rigid even with a smooth camera; the camera up-damp
//! is deliberately a touch slower than the position damp, which on a hard
//! direction reversal lets the horizon lag for a few frames before catching up
//! (a readable trade, not a bug). The re-projection snap means zero "slope" feel
//! — the surface is mathematically perfect, so you never get the weight of
//! cresting a hill, and the props sit on a single shared radius so the boxes ride
//! a hair proud of the surface rather than half-buried. The jump is purely radial
//! with an instant landing snap (no squash), which reads abrupt. At the exact
//! pole the tangent basis is degenerate and is reseeded from a world axis; the
//! reseed is continuous in practice but a *very* slow crawl directly over the
//! singularity can show a one-frame heading flick — the honest cost of a
//! single-chart sphere parameterization.
//!
//! **Bevy 0.18 gotchas:**
//!   * Spawn meshes with `Mesh3d(handle)` + `MeshMaterial3d(handle)` — no
//!     `PbrBundle`. The planet is a `Sphere::new(R).mesh().ico(..)`; props are
//!     `Cone { radius, height }` and `Cuboid::new(..)`.
//!   * Scoped cleanup is `DespawnOnExit(state)` (0.18), NOT `StateScoped`. EVERY
//!     prop carries it too; shared per-kind mesh/material handles are fine (Bevy
//!     ref-counts assets — they drop when the scoped entities despawn).
//!   * Per-sample mutable state (heading/velocity AND the smoothed camera rig)
//!     lives in `Resource`s that are RESET in `OnEnter` — `DespawnOnExit` only
//!     despawns entities, it does not reset resources, so a re-entry would
//!     otherwise inherit a stale camera/heading.
//!   * Orient a prop to its surface normal with
//!     `Quat::from_rotation_arc(Vec3::Y, normal)` — the shortest rotation taking
//!     local +Y to the normal. Do NOT `looking_at` with a world up (props near a
//!     pole would shear).
//!   * Camera smoothing must be frame-rate-independent: lerp by
//!     `t = 1 - exp(-rate * dt)` (dt clamped), NOT a fixed `lerp(.., 0.1)` per
//!     frame, which would damp differently at 30 vs 144 fps. Renormalize the
//!     lerped up (a lerp of two unit vecs is not unit) and snap past the
//!     antiparallel case (where the lerp passes through ~zero).
//!   * `Time` delta is `time.delta_secs()` (f32), not `delta_seconds()`.
//!   * Jump is edge-triggered: `ButtonInput<KeyCode>::just_pressed` (NOT
//!     `pressed`, which would re-fire every frame Space is held).
//!   * Build the player orientation with `Quat::from_mat3(&Mat3::from_cols(..))`
//!     from an explicit orthonormal right/up/back basis — do NOT use a fixed
//!     world-up `look_to`, which breaks at the poles.
//!
//! **Shared input:** turn/walk read the global [`MoveIntent`] resource (WASD on
//! world axes, W = -Z, A = -X) owned by `engine::input::FoundationInputPlugin`;
//! this sample interprets `.dir.z` as walk and `.dir.x` as turn so it never polls
//! the keyboard for movement. Jump reads `ButtonInput<KeyCode>` directly (a
//! one-off edge, not a shared intent).
//!
//! **Shared scene:** only the light preset is reused — the flat ground is
//! intentionally NOT used (the planet replaces it). Light + player + camera +
//! every scenery prop are all `DespawnOnExit`-scoped.

use bevy::prelude::*;

use crate::engine::hud;
use crate::engine::input::MoveIntent;
use crate::engine::scene;

use super::{AppState, SampleMeta};

pub const META: SampleMeta = SampleMeta {
    id: "12-tiny-planet",
    title: "Tiny planet (spherical gravity)",
    summary: "Walk all the way around a sphere — gravity pulls to its center, up = surface normal.",
    tags: &["movement", "gravity", "spherical", "camera"],
};

/// Planet radius (world units). The player walks on its surface.
const PLANET_RADIUS: f32 = 6.0;
/// Player capsule radius (world units).
const PLAYER_RADIUS: f32 = 0.4;
/// Player capsule body length between the hemisphere centers (world units).
const PLAYER_BODY: f32 = 0.8;
/// Distance from the planet center at which the player's *origin* rests when
/// grounded: planet surface plus the capsule's half-height so its feet touch.
const SURFACE_OFFSET: f32 = PLANET_RADIUS + PLAYER_RADIUS + PLAYER_BODY * 0.5;
/// Walk speed along the surface (world units / second of arc length).
const WALK_SPEED: f32 = 4.0;
/// Heading turn rate (radians / second) for A/D tank turning.
const TURN_SPEED: f32 = 2.2;
/// Radial gravity acceleration (world units / second^2), pulling toward center.
const GRAVITY: f32 = 20.0;
/// Radial speed imparted by a jump (world units / second, outward).
const JUMP_SPEED: f32 = 8.0;
/// Camera distance behind the player along the surface (tangent units).
const CAMERA_BACK: f32 = 6.0;
/// Camera height above the player along the surface normal (world units).
const CAMERA_UP: f32 = 3.5;
/// Camera position smoothing rate (1/seconds). Higher = snappier follow. Feeds
/// the frame-rate-independent damp `t = 1 - exp(-rate * dt)`.
const CAMERA_POS_DAMP: f32 = 10.0;
/// Camera up-vector smoothing rate (1/seconds). Lower than the position rate so
/// the horizon rolls a touch behind the move, which reads as less stiff.
const CAMERA_UP_DAMP: f32 = 6.0;
/// Largest `dt` fed to the camera damp. Clamps a frame-time spike (e.g. after a
/// stall) so the damp factor stays sane and the camera can't snap-jump.
const CAMERA_MAX_DT: f32 = 1.0 / 30.0;
/// If the smoothed up and the target up are more antiparallel than this (dot <
/// this), lerping them would pass through ~zero — snap to the target instead.
const CAMERA_UP_ANTIPARALLEL: f32 = -0.99;

/// Number of scenery props scattered across the planet surface.
const PROP_COUNT: usize = 8;
/// Cone (stylized tree/spire) height (world units).
const PROP_CONE_HEIGHT: f32 = 1.1;
/// Cone (stylized tree/spire) base radius (world units).
const PROP_CONE_RADIUS: f32 = 0.35;
/// Box (rock/crate) full edge length (world units).
const PROP_BOX_SIZE: f32 = 0.6;
/// Distance from the planet center at which a prop's *origin* sits. Lifted half
/// a cone height above [`PLANET_RADIUS`] so a prop's base rests on the surface
/// rather than sinking into it (a single shared offset keeps placement simple;
/// the cone is the tallest kind, so the box just sits slightly proud — fine for
/// scenery).
const PROP_SURFACE_RADIUS: f32 = PLANET_RADIUS + PROP_CONE_HEIGHT * 0.5;

/// Per-sample mutable controller state. RESET in `OnEnter` (a `Resource` is not
/// touched by `DespawnOnExit`, so re-entering the sample must re-seed it).
#[derive(Resource, Debug, Clone, Copy)]
struct PlanetWalker {
    /// World position of the player origin (always re-projected onto the sphere
    /// shell after tangent movement; lifts off the shell only during a jump).
    position: Vec3,
    /// Current forward tangent (unit, perpendicular to the surface normal).
    /// Carried frame-to-frame and re-orthogonalized against the new up.
    forward: Vec3,
    /// Radial velocity along the surface normal (jump up, gravity down).
    radial_velocity: f32,
}

impl Default for PlanetWalker {
    fn default() -> Self {
        // Start on the "north pole" (+Y), facing -Z along the tangent plane.
        let position = Vec3::Y * SURFACE_OFFSET;
        let up = surface_normal(position);
        Self {
            position,
            forward: orthonormalize_forward(Vec3::NEG_Z, up),
            radial_velocity: 0.0,
        }
    }
}

/// Smoothed follow-camera state, carried frame-to-frame so the camera can damp
/// toward its target pose instead of snapping. RESET in `OnEnter` alongside
/// [`PlanetWalker`] (a `Resource` survives `DespawnOnExit`). `up` is kept unit.
#[derive(Resource, Debug, Clone, Copy)]
struct CameraRig {
    /// Current (smoothed) world-space camera eye position.
    eye: Vec3,
    /// Current (smoothed) camera up vector — lerped toward the player's surface
    /// normal each frame and renormalized (a lerp of two unit vecs isn't unit).
    up: Vec3,
}

impl CameraRig {
    /// Seeds the rig from a walker pose so frame 0 starts already settled (no
    /// initial lerp-in from the origin).
    fn settled(walker: &PlanetWalker) -> Self {
        let up = surface_normal(walker.position);
        Self {
            eye: camera_eye(walker.position, walker.forward, up),
            up,
        }
    }
}

#[derive(Component)]
struct Player;

#[derive(Component)]
struct FollowCamera;

pub struct TinyPlanetPlugin;

impl Plugin for TinyPlanetPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(OnEnter(AppState::S12TinyPlanet), setup).add_systems(
            Update,
            (walk_on_planet, update_camera)
                .chain()
                .run_if(in_state(AppState::S12TinyPlanet)),
        );
    }
}

fn setup(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    let state = AppState::S12TinyPlanet;
    let scope = DespawnOnExit(state);

    // RESET per-sample state on every enter (resources survive DespawnOnExit).
    let walker = PlanetWalker::default();
    commands.insert_resource(walker);
    // Seed the smoothed camera rig settled on the start pose (no initial lerp-in).
    commands.insert_resource(CameraRig::settled(&walker));

    // Light preset only — the planet replaces the flat ground (NOT spawned).
    scene::spawn_light_preset(&mut commands, state);

    // The planet.
    commands.spawn((
        Mesh3d(meshes.add(Sphere::new(PLANET_RADIUS).mesh().ico(5).unwrap())),
        MeshMaterial3d(materials.add(StandardMaterial {
            base_color: Color::srgb(0.35, 0.45, 0.55),
            perceptual_roughness: 0.9,
            ..default()
        })),
        Transform::IDENTITY,
        scope.clone(),
    ));

    // Scenery props scattered over the surface, each oriented so its local +Y is
    // the surface normal — they stick out radially like objects on a tiny planet
    // (equator, both poles, underside) instead of all pointing world-up. Static
    // scenery: no physics, no marker, just DespawnOnExit-scoped meshes. Mesh +
    // material handles are shared per kind (Bevy ref-counts; they drop when the
    // scoped entities despawn on exit).
    let cone_mesh = meshes.add(Cone {
        radius: PROP_CONE_RADIUS,
        height: PROP_CONE_HEIGHT,
    });
    let box_mesh = meshes.add(Cuboid::new(PROP_BOX_SIZE, PROP_BOX_SIZE, PROP_BOX_SIZE));
    let cone_material = materials.add(StandardMaterial {
        base_color: Color::srgb(0.25, 0.6, 0.35),
        perceptual_roughness: 0.8,
        ..default()
    });
    let box_material = materials.add(StandardMaterial {
        base_color: Color::srgb(0.6, 0.55, 0.45),
        perceptual_roughness: 1.0,
        ..default()
    });
    for i in 0..PROP_COUNT {
        let dir = prop_direction(i);
        let (mesh, material) = if i % 2 == 0 {
            (cone_mesh.clone(), cone_material.clone())
        } else {
            (box_mesh.clone(), box_material.clone())
        };
        commands.spawn((
            Mesh3d(mesh),
            MeshMaterial3d(material),
            prop_transform(dir),
            scope.clone(),
        ));
    }

    // The player capsule, placed + oriented from the initial walker state.
    let up = surface_normal(walker.position);
    commands.spawn((
        Player,
        Mesh3d(meshes.add(Capsule3d::new(PLAYER_RADIUS, PLAYER_BODY))),
        MeshMaterial3d(materials.add(StandardMaterial {
            base_color: Color::srgb(0.9, 0.4, 0.3),
            ..default()
        })),
        player_transform(walker.position, walker.forward, up),
        scope.clone(),
    ));

    // Follow camera (separable — see `update_camera`). Initial pose comes from
    // the settled rig so the first frame already matches the smoothed target.
    let rig = CameraRig::settled(&walker);
    commands.spawn((
        FollowCamera,
        Camera3d::default(),
        camera_look(rig.eye, walker.position, rig.up),
        scope,
    ));

    hud::spawn_controls_overlay(
        &mut commands,
        state,
        &[
            "A/D — turn",
            "W/S — walk",
            "Space — jump",
            "Esc — back to menu",
        ],
    );
    hud::spawn_fps_counter(&mut commands, state);
}

/// Drives the whole spherical controller for one frame: turn the heading, walk
/// along the tangent plane, re-project onto the sphere, integrate radial gravity
/// and jump, then orient the player capsule. All the load-bearing math is in
/// pure helpers below so it is testable headless.
fn walk_on_planet(
    time: Res<Time>,
    intent: Res<MoveIntent>,
    keyboard: Res<ButtonInput<KeyCode>>,
    mut walker: ResMut<PlanetWalker>,
    mut player: Query<&mut Transform, With<Player>>,
) {
    let dt = time.delta_secs();
    // MoveIntent maps WASD onto world axes (W = -Z walk forward, A = -X turn
    // left). On a sphere we reinterpret those as scalar walk/turn inputs.
    let walk = -intent.dir.z; // W (-Z) => forward (+)
    let turn = -intent.dir.x; // A (-X) => turn left (+)
    let jump = keyboard.just_pressed(KeyCode::Space);

    let next = step_walker(*walker, walk, turn, jump, dt);
    *walker = next;

    if let Ok(mut transform) = player.single_mut() {
        let up = surface_normal(next.position);
        *transform = player_transform(next.position, next.forward, up);
    }
}

/// **SEPARABLE** polished follow camera. Sits behind + above the player along
/// the tangent/normal frame and looks at the player. Instead of snapping to the
/// target pose every frame, it damps the eye position AND the up vector toward
/// their targets with a frame-rate-independent factor `t = 1 - exp(-rate * dt)`
/// (dt clamped), renormalizing the lerped up and snapping past an antiparallel
/// flip — so turning around the globe feels smooth and the horizon stays
/// readable. All the math is in the pure [`damp_camera`] helper for headless
/// testing; this system just plumbs ECS state through it.
fn update_camera(
    time: Res<Time>,
    walker: Res<PlanetWalker>,
    mut rig: ResMut<CameraRig>,
    mut camera: Query<&mut Transform, With<FollowCamera>>,
) {
    let Ok(mut cam) = camera.single_mut() else {
        return;
    };
    let dt = time.delta_secs().min(CAMERA_MAX_DT);
    let target_up = surface_normal(walker.position);
    let target_eye = camera_eye(walker.position, walker.forward, target_up);

    *rig = damp_camera(*rig, target_eye, target_up, dt);
    *cam = camera_look(rig.eye, walker.position, rig.up);
}

// ---------------------------------------------------------------------------
// Pure helpers (no ECS) — the testable core of the mechanic.
// ---------------------------------------------------------------------------

/// Surface normal (= local up) at a world position: the unit vector from the
/// planet center (origin) to the position. Guarded against a zero-length input
/// (degenerate exactly at the center) by falling back to +Y.
fn surface_normal(position: Vec3) -> Vec3 {
    position.try_normalize().unwrap_or(Vec3::Y)
}

/// Re-projects a position onto the sphere shell at [`SURFACE_OFFSET`] from the
/// center, preserving its direction. After tangent-plane movement the position
/// drifts slightly off the sphere (it moved on the flat tangent, not the curve);
/// this pulls it back so the player never leaves the surface.
fn reproject_to_sphere(position: Vec3) -> Vec3 {
    surface_normal(position) * SURFACE_OFFSET
}

/// Orthonormalizes a desired forward against the surface normal `up`, returning a
/// unit tangent perpendicular to `up`. Guards the degenerate case (desired ~=
/// parallel to up, e.g. at a pole): reseeds from a world axis NOT parallel to up
/// so the result is never zero or NaN.
fn orthonormalize_forward(desired: Vec3, up: Vec3) -> Vec3 {
    // Minimum tangent-component length to trust a projection as non-degenerate.
    // Larger than `try_normalize`'s tiny epsilon so a near-parallel `desired`
    // (e.g. at a pole) reliably triggers the reseed instead of normalizing a
    // float-residual vector that would not be truly perpendicular to `up`.
    const MIN_TANGENT: f32 = 1e-3;

    let project = |v: Vec3| v - up * v.dot(up);

    // Project `desired` onto the tangent plane (remove its `up` component).
    let projected = project(desired);
    if projected.length() > MIN_TANGENT {
        return projected.normalize();
    }
    // Degenerate: `desired` was (nearly) parallel to `up`. Reseed from a world
    // axis that is not parallel to up. Try +Z first, then +X.
    for axis in [Vec3::Z, Vec3::X] {
        let projected = project(axis);
        if projected.length() > MIN_TANGENT {
            return projected.normalize();
        }
    }
    // Unreachable for a unit `up` (Z and X can't both be parallel to it), but
    // return a safe default rather than risk a NaN.
    Vec3::Z
}

/// One integration step of the full controller. Pure (no ECS / `Time`) so the
/// mechanic is testable with a fixed `dt`. Order: turn heading → walk on the
/// tangent → re-project onto the sphere → integrate radial gravity/jump →
/// re-stabilize the forward against the new up.
fn step_walker(mut w: PlanetWalker, walk: f32, turn: f32, jump: bool, dt: f32) -> PlanetWalker {
    let up = surface_normal(w.position);

    // 1. Turn the heading about the current up (A/D). Rotate forward in place.
    if turn != 0.0 {
        let rot = Quat::from_axis_angle(up, turn * TURN_SPEED * dt);
        w.forward = orthonormalize_forward(rot * w.forward, up);
    } else {
        // Re-stabilize forward against the current up even when not turning.
        w.forward = orthonormalize_forward(w.forward, up);
    }

    // 2. Walk along the tangent plane (W/S), then re-project onto the sphere so
    //    the player never drifts off the curved surface. Only walk while
    //    grounded; a jump's extra height is handled by the radial integrator.
    let grounded = is_grounded(w.position);
    if walk != 0.0 && grounded {
        w.position += w.forward * walk * WALK_SPEED * dt;
        w.position = reproject_to_sphere(w.position);
    }

    // 3. Radial gravity + jump along the (possibly new) up.
    let new_up = surface_normal(w.position);
    let mut radius = w.position.length().max(f32::EPSILON);
    if grounded && jump {
        w.radial_velocity = JUMP_SPEED;
    }
    w.radial_velocity -= GRAVITY * dt;
    radius += w.radial_velocity * dt;
    if radius <= SURFACE_OFFSET {
        radius = SURFACE_OFFSET;
        w.radial_velocity = 0.0;
    }
    w.position = new_up * radius;

    // 4. Re-orthogonalize forward against the final up (stable basis, pole-safe).
    w.forward = orthonormalize_forward(w.forward, surface_normal(w.position));
    w
}

/// True when the player origin is on (or below) the grounded shell radius.
fn is_grounded(position: Vec3) -> bool {
    position.length() <= SURFACE_OFFSET + 1e-3
}

/// Builds the player Transform from position + forward tangent + up normal: an
/// orthonormal basis (right, up, back) → rotation, translated to position. The
/// capsule's local +Y aligns to the surface normal so it visibly tilts around
/// the globe.
fn player_transform(position: Vec3, forward: Vec3, up: Vec3) -> Transform {
    let basis = orientation_basis(forward, up);
    Transform {
        translation: position,
        rotation: Quat::from_mat3(&basis),
        scale: Vec3::ONE,
    }
}

/// The *target* camera eye for a player pose: behind the player by
/// [`CAMERA_BACK`] along -forward and above by [`CAMERA_UP`] along the normal.
/// The smoothed rig damps toward this each frame.
fn camera_eye(position: Vec3, forward: Vec3, up: Vec3) -> Vec3 {
    position - forward * CAMERA_BACK + up * CAMERA_UP
}

/// Builds a camera Transform looking from `eye` at `target` with `up` as the
/// camera up (the curved horizon). Thin wrapper over `looking_at` kept separate
/// so the smoothed eye/up from the rig and the static initial pose share it.
fn camera_look(eye: Vec3, target: Vec3, up: Vec3) -> Transform {
    Transform::from_translation(eye).looking_at(target, up)
}

/// Frame-rate-independent damp factor in `[0, 1)`: `t = 1 - exp(-rate * dt)`.
/// `dt` is assumed already clamped (see [`CAMERA_MAX_DT`]). Monotonically
/// increasing in both `rate` and `dt`; `t = 0` when `dt = 0` (no movement).
fn damp_factor(rate: f32, dt: f32) -> f32 {
    1.0 - (-rate * dt).exp()
}

/// Advances the smoothed camera rig one step toward its target eye/up. The eye
/// lerps with [`CAMERA_POS_DAMP`]; the up lerps with [`CAMERA_UP_DAMP`], is
/// renormalized (a lerp of two unit vecs is not unit), and snaps to the target
/// if the current up is nearly antiparallel to it (where the lerp would pass
/// through ~zero and the renormalize would be unstable). Pure → testable.
fn damp_camera(mut rig: CameraRig, target_eye: Vec3, target_up: Vec3, dt: f32) -> CameraRig {
    let pos_t = damp_factor(CAMERA_POS_DAMP, dt);
    rig.eye = rig.eye.lerp(target_eye, pos_t);

    if rig.up.dot(target_up) < CAMERA_UP_ANTIPARALLEL {
        // Antiparallel: interpolation is degenerate, snap straight to target.
        rig.up = target_up;
    } else {
        let up_t = damp_factor(CAMERA_UP_DAMP, dt);
        // Renormalize: the lerp of two unit vectors is generally not unit.
        rig.up = rig.up.lerp(target_up, up_t).normalize_or(target_up);
    }
    rig
}

/// Deterministic direction (unit vector) for scenery prop `i`, spread over the
/// whole sphere via a Fibonacci-sphere distribution so props land at the equator,
/// near both poles, and on the underside — not clustered on one hemisphere.
fn prop_direction(i: usize) -> Vec3 {
    // Golden-angle spiral: y sweeps top→bottom, theta winds by the golden angle.
    const GOLDEN_ANGLE: f32 = 2.399_963_2; // pi * (3 - sqrt(5)) radians
    let n = PROP_COUNT as f32;
    // Map i to y in (1, -1), avoiding the exact poles (so a prop is *near* but
    // not *at* a pole, which keeps its tangent frame well-defined).
    let y = 1.0 - 2.0 * (i as f32 + 0.5) / n;
    let radius = (1.0 - y * y).max(0.0).sqrt();
    let theta = GOLDEN_ANGLE * i as f32;
    Vec3::new(radius * theta.cos(), y, radius * theta.sin())
}

/// Orientation that maps a prop's local +Y onto the surface normal `normal`, so
/// the prop sticks out radially from the planet. `Quat::from_rotation_arc` builds
/// the shortest rotation taking `Vec3::Y` to `normal` (both unit), which is
/// exactly "stand this object up along the local up".
fn prop_orientation(normal: Vec3) -> Quat {
    Quat::from_rotation_arc(Vec3::Y, normal)
}

/// Full prop Transform from a surface direction: position on the surface shell
/// and orientation so local +Y = the surface normal (radial stick-out).
fn prop_transform(direction: Vec3) -> Transform {
    let normal = direction.normalize();
    Transform {
        translation: normal * PROP_SURFACE_RADIUS,
        rotation: prop_orientation(normal),
        scale: Vec3::ONE,
    }
}

/// Orthonormal rotation basis (as a `Mat3` of columns right/up/back) from a
/// forward tangent and an up normal, both assumed unit & perpendicular. `back`
/// is `-forward` so the capsule's local -Z faces the heading (Bevy convention).
fn orientation_basis(forward: Vec3, up: Vec3) -> Mat3 {
    let right = forward.cross(up).normalize_or_zero();
    let back = -forward;
    Mat3::from_cols(right, up, back)
}

#[cfg(test)]
mod tests {
    use super::*;

    const EPS: f32 = 1e-4;

    /// `surface_normal` is the normalized position (= up) for any point, and
    /// safely returns a unit vector even at the degenerate center.
    #[test]
    fn surface_normal_is_unit_radial() {
        let p = Vec3::new(3.0, -4.0, 12.0);
        let n = surface_normal(p);
        assert!((n.length() - 1.0).abs() < EPS, "normal must be unit");
        // Radial: the normal equals the position direction (dot of unit vectors ~1).
        assert!(
            n.dot(p.normalize()) > 1.0 - EPS,
            "normal must point along the position (radially out)"
        );
        // Degenerate center never yields NaN/zero.
        let z = surface_normal(Vec3::ZERO);
        assert!(z.is_finite() && (z.length() - 1.0).abs() < EPS);
    }

    /// Re-projection puts any point exactly on the grounded shell, distance
    /// `SURFACE_OFFSET` from the center, regardless of input magnitude.
    #[test]
    fn reproject_keeps_player_on_sphere() {
        for p in [
            Vec3::new(100.0, 0.0, 0.0),
            Vec3::new(0.1, 0.2, 0.05),
            Vec3::new(-3.0, 4.0, -1.0),
        ] {
            let r = reproject_to_sphere(p).length();
            assert!(
                (r - SURFACE_OFFSET).abs() < EPS,
                "reprojected radius must equal SURFACE_OFFSET, got {r}"
            );
        }
    }

    /// The tangent basis is orthonormal and the forward is perpendicular to up.
    #[test]
    fn tangent_basis_is_orthonormal() {
        let up = Vec3::new(1.0, 2.0, 3.0).normalize();
        let forward = orthonormalize_forward(Vec3::NEG_Z, up);
        assert!((forward.length() - 1.0).abs() < EPS, "forward must be unit");
        assert!(forward.dot(up).abs() < EPS, "forward must be perpendicular to up");

        let basis = orientation_basis(forward, up);
        let right = basis.col(0);
        let b_up = basis.col(1);
        let back = basis.col(2);
        for v in [right, b_up, back] {
            assert!((v.length() - 1.0).abs() < EPS, "basis columns must be unit");
        }
        assert!(right.dot(b_up).abs() < EPS, "right perpendicular to up");
        assert!(right.dot(back).abs() < EPS, "right perpendicular to back");
        assert!(b_up.dot(back).abs() < EPS, "up perpendicular to back");
    }

    /// The degenerate case (desired forward parallel to up, i.e. at a pole) never
    /// returns NaN or a zero vector — it reseeds from a non-parallel world axis.
    #[test]
    fn degenerate_forward_reseeds_without_nan() {
        // up = +Y; desired = +Y (parallel) — the projection is zero.
        let up = Vec3::Y;
        let forward = orthonormalize_forward(Vec3::Y, up);
        assert!(forward.is_finite(), "reseed must not produce NaN");
        assert!((forward.length() - 1.0).abs() < EPS, "reseed must be unit");
        assert!(forward.dot(up).abs() < EPS, "reseed must be perpendicular to up");

        // Same for up = -Y and up = an arbitrary axis with a parallel desired.
        for up in [Vec3::NEG_Y, Vec3::new(2.0, -1.0, 0.5).normalize()] {
            let forward = orthonormalize_forward(up, up);
            assert!(forward.is_finite() && (forward.length() - 1.0).abs() < EPS);
            assert!(forward.dot(up).abs() < EPS);
        }
    }

    /// Walking forward keeps the player on the sphere and actually moves it (the
    /// integrated controller never lets the player drift off the surface).
    #[test]
    fn walking_stays_on_sphere_and_advances() {
        let mut w = PlanetWalker::default();
        let start = w.position;
        let dt = 1.0 / 60.0;
        for _ in 0..120 {
            w = step_walker(w, 1.0, 0.0, false, dt);
            let r = w.position.length();
            assert!(
                (r - SURFACE_OFFSET).abs() < 1e-2,
                "player must stay on the grounded shell while walking, got r={r}"
            );
            assert!(w.position.is_finite() && w.forward.is_finite(), "no NaN");
        }
        assert!(
            w.position.distance(start) > 1.0,
            "walking should move the player a meaningful arc, moved {}",
            w.position.distance(start)
        );
    }

    /// Walking far enough crosses the pole onto the underside — the controller
    /// has no hardcoded world-up assumption that traps the player on top.
    #[test]
    fn can_walk_over_the_pole_to_the_underside() {
        let mut w = PlanetWalker::default();
        assert!(w.position.y > 0.0, "starts on the +Y (north) side");
        let dt = 1.0 / 60.0;
        // Walk a full revolution's worth of steps and track the lowest point we
        // reach. Crossing onto the underside means y goes negative somewhere on
        // the path — proving there's no hardcoded world-up trap at the pole.
        // (Walking a whole loop returns near the start, so we assert the MIN y,
        // not the final y.)
        let mut min_y = w.position.y;
        for _ in 0..700 {
            w = step_walker(w, 1.0, 0.0, false, dt);
            min_y = min_y.min(w.position.y);
            assert!(
                (w.position.length() - SURFACE_OFFSET).abs() < 1e-2,
                "stays glued to the sphere all the way around, r={}",
                w.position.length()
            );
        }
        assert!(
            min_y < -SURFACE_OFFSET * 0.5,
            "walking forward must carry the player well onto the underside, min_y={min_y}"
        );
    }

    /// A grounded jump lifts the player radially outward, then gravity returns it
    /// to the grounded shell with zero radial velocity (no drift off-sphere).
    #[test]
    fn jump_then_gravity_returns_to_surface() {
        let mut w = PlanetWalker::default();
        let dt = 1.0 / 60.0;
        // Frame 1: grounded jump.
        w = step_walker(w, 0.0, 0.0, true, dt);
        assert!(
            w.position.length() > SURFACE_OFFSET,
            "jump should lift the player off the shell"
        );
        assert!(w.radial_velocity > 0.0, "radial velocity should be outward after jump");

        // Integrate until it settles back down.
        let mut peak = w.position.length();
        for _ in 0..300 {
            w = step_walker(w, 0.0, 0.0, false, dt);
            peak = peak.max(w.position.length());
        }
        assert!(peak > SURFACE_OFFSET + 0.3, "jump arc should rise meaningfully, peak={peak}");
        assert!(
            (w.position.length() - SURFACE_OFFSET).abs() < 1e-3,
            "gravity should settle the player back onto the shell"
        );
        assert_eq!(w.radial_velocity, 0.0, "radial velocity zeroed once grounded");
    }

    /// A prop's orientation maps its local +Y onto the surface normal for every
    /// kind of placement — equator, both poles, and the underside — so each prop
    /// sticks out radially rather than all pointing world-up.
    #[test]
    fn prop_orientation_maps_local_up_to_surface_normal() {
        let normals = [
            Vec3::Y,                              // north pole
            Vec3::NEG_Y,                          // south pole
            Vec3::X,                              // equator (+X)
            Vec3::NEG_Z,                          // equator (-Z)
            Vec3::new(1.0, -1.0, 0.5).normalize(), // underside (negative Y component)
            Vec3::new(-2.0, -3.0, 1.0).normalize(),
        ];
        for normal in normals {
            let rotated = prop_orientation(normal) * Vec3::Y;
            assert!(
                rotated.distance(normal) < EPS,
                "local +Y must rotate onto the surface normal {normal:?}, got {rotated:?}"
            );
            // The rotation must be valid (unit quaternion → finite rotated vec).
            assert!(rotated.is_finite(), "orientation must not produce NaN");
        }
    }

    /// `prop_transform` places the prop on the surface shell (origin at
    /// `PROP_SURFACE_RADIUS`) and orients local +Y to the radial normal, even at
    /// a pole and on the underside.
    #[test]
    fn prop_transform_sits_on_shell_and_sticks_out_radially() {
        for i in 0..PROP_COUNT {
            let dir = prop_direction(i);
            assert!(
                (dir.length() - 1.0).abs() < EPS,
                "prop direction must be unit, got {}",
                dir.length()
            );
            let t = prop_transform(dir);
            assert!(
                (t.translation.length() - PROP_SURFACE_RADIUS).abs() < EPS,
                "prop origin must rest on the surface shell"
            );
            // Local +Y (the prop's up) points along the surface normal = radially.
            let local_up = t.rotation * Vec3::Y;
            assert!(
                local_up.dot(dir.normalize()) > 1.0 - EPS,
                "prop's local up must point radially outward"
            );
        }
        // The Fibonacci spread must actually cover top, bottom, and the sides.
        let ys: Vec<f32> = (0..PROP_COUNT).map(|i| prop_direction(i).y).collect();
        assert!(ys.iter().cloned().fold(f32::MAX, f32::min) < -0.5, "a prop must land on the underside");
        assert!(ys.iter().cloned().fold(f32::MIN, f32::max) > 0.5, "a prop must land near the top");
    }

    /// The frame-rate-independent damp factor `t = 1 - exp(-rate * dt)` is in
    /// `[0, 1)`, is zero at `dt = 0`, and is strictly monotonic increasing in
    /// `dt` — the property that makes the smoothing consistent across frame rates.
    #[test]
    fn damp_factor_is_unit_bounded_and_monotonic() {
        let rate = CAMERA_POS_DAMP;
        assert_eq!(damp_factor(rate, 0.0), 0.0, "no time elapsed => no movement");

        let mut prev = 0.0;
        let mut dt = 0.0;
        for _ in 0..50 {
            dt += 1.0 / 240.0;
            let t = damp_factor(rate, dt);
            assert!((0.0..1.0).contains(&t), "damp factor must stay in [0, 1), got {t}");
            assert!(t > prev, "damp factor must increase with dt ({t} !> {prev})");
            prev = t;
        }
    }

    /// `damp_camera` eases the eye/up toward their targets without ever leaving
    /// the up un-normalized or producing NaN, and snaps cleanly through an
    /// antiparallel up flip instead of collapsing through zero.
    #[test]
    fn damp_camera_smooths_and_renormalizes_up() {
        let walker = PlanetWalker::default();
        let mut rig = CameraRig::settled(&walker);
        // Target the OPPOSITE pole: up must travel from +Y toward -Y, passing the
        // antiparallel snap guard at some point — and never go non-finite.
        let target_up = Vec3::NEG_Y;
        let target_eye = Vec3::new(2.0, -3.0, 1.0);
        let dt = 1.0 / 60.0;
        for _ in 0..600 {
            rig = damp_camera(rig, target_eye, target_up, dt);
            assert!(rig.up.is_finite() && rig.eye.is_finite(), "no NaN in the rig");
            assert!(
                (rig.up.length() - 1.0).abs() < 1e-3,
                "rig up must stay unit-length, got {}",
                rig.up.length()
            );
        }
        assert!(rig.up.distance(target_up) < 1e-2, "up should converge to target");
        assert!(rig.eye.distance(target_eye) < 1e-2, "eye should converge to target");
    }
}
