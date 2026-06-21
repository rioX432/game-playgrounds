//! # s12 — Spherical gravity + walk-on-sphere (Messenger-style tiny planet)
//!
//! **What it demonstrates:** A "tiny planet" where gravity always pulls toward a
//! sphere's center and the player's local *up* aligns to the surface normal, so
//! you can walk all the way around the globe — over the top, around the side, and
//! across the underside — without ever "falling off". Pure kinematic math (NO
//! physics engine): the player position is re-projected onto the sphere every
//! frame, a stable tangent basis is carried frame-to-frame, and a follow camera
//! rides with the surface normal as its up so the horizon curves. This is the
//! 12a CORE controller; a follow-up (#42, "12b") extends THIS sample with
//! environment props + a polished follow camera + final feel notes, so the
//! camera logic lives in one separable [`update_camera`] function.
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
//! side is the payoff, and the camera's curved horizon sells it. Honest bad
//! parts: tank turning (A/D) feels stiff and dated next to twin-stick/mouse-look;
//! there is no acceleration on either turn or walk, so everything is instant and
//! arcade-rigid. The re-projection snap is invisible at walking speed but means
//! there is zero "slope" feel — the surface is mathematically perfect, so you
//! never get the subtle weight of cresting a hill. The jump is purely radial with
//! an instant landing snap (no squash), which reads abrupt. At the exact pole the
//! tangent basis is degenerate and is reseeded from a world axis; the reseed is
//! continuous in practice but a *very* slow crawl directly over the singularity
//! can show a one-frame heading flick — documented as the honest cost of a
//! single-chart sphere parameterization.
//!
//! **Bevy 0.18 gotchas:**
//!   * Spawn meshes with `Mesh3d(handle)` + `MeshMaterial3d(handle)` — no
//!     `PbrBundle`. The planet is a `Sphere::new(R).mesh().ico(..)`.
//!   * Scoped cleanup is `DespawnOnExit(state)` (0.18), NOT `StateScoped`.
//!   * Per-sample mutable state (heading/velocity) lives in a `Resource` that is
//!     RESET in `OnEnter` — `DespawnOnExit` only despawns entities, it does not
//!     reset resources, so a re-entry would otherwise inherit stale state.
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
//! intentionally NOT used (the planet replaces it). Light + player + camera are
//! all `DespawnOnExit`-scoped.

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

    // Follow camera (separable — see `update_camera`). Initial pose mirrors it.
    commands.spawn((
        FollowCamera,
        Camera3d::default(),
        camera_transform(walker.position, walker.forward, up),
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

/// **SEPARABLE** follow camera (kept its own fn for #42's polished camera). Sits
/// behind + above the player along the tangent/normal frame, looking at the
/// player, with the camera's up set to the surface normal so the horizon curves.
fn update_camera(walker: Res<PlanetWalker>, mut camera: Query<&mut Transform, With<FollowCamera>>) {
    let Ok(mut cam) = camera.single_mut() else {
        return;
    };
    let up = surface_normal(walker.position);
    *cam = camera_transform(walker.position, walker.forward, up);
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

/// Builds the follow camera Transform: behind the player by [`CAMERA_BACK`] along
/// -forward and above by [`CAMERA_UP`] along the normal, looking at the player
/// with the surface normal as the camera up (curved horizon).
fn camera_transform(position: Vec3, forward: Vec3, up: Vec3) -> Transform {
    let eye = position - forward * CAMERA_BACK + up * CAMERA_UP;
    Transform::from_translation(eye).looking_at(position, up)
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
}
