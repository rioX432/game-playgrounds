//! # s16 — Guard AI (FSM patrol → detect → chase → return)
//!
//! **What it demonstrates:** A minimal NPC guard driven by a **hand-rolled finite
//! state machine** (`patrol → detect → chase → return`) on top of **hand-rolled
//! steering** (seek / arrive / avoid). It is the decision-layer capstone of the
//! Ch4 (NPC/AI) chapter: sample 14 proved the navmesh *query* half, sample 15 the
//! *steering* half, and this one fuses them under an FSM. The chase state reuses
//! the Ch4 navmesh foundation (`engine::nav`) to path-find to the intruder and
//! then **steers** along that path (rather than s14's omniscient exact-snap
//! `advance`), so the motion reads like an agent reacting, not a teleporting
//! oracle.
//!
//! **Controls:** None — it runs itself. A scripted "intruder" (red) loops in and
//! out of the guard's detection radius, cycling the guard (capsule, tinted by
//! state) through all four states forever. The current state is shown top-left and
//! the live navmesh chase/return path is drawn as a gizmo. `Esc` returns to the
//! menu (auto-despawns everything).
//!
//! **FSM (the contract the headless test pins):**
//!   * **Patrol** — walk a fixed patrol loop. Intruder within `DETECT_RADIUS` → Detect.
//!   * **Detect** — creep toward the intruder while *confirming*. Stay in range for
//!     `DETECT_CONFIRM_SECS` → Chase; intruder leaves range first → back to Patrol
//!     (false alarm). This is the transient that makes the `patrol→detect→chase`
//!     ordering observable instead of an instant snap.
//!   * **Chase** — re-path to the intruder's *current* cell every `REPATH_SECS` and
//!     steer along the navmesh polyline (waypoint leg index advances as it goes).
//!     Give up when lured past the `CHASE_LEASH` from the home post (the guard is
//!     faster than the intruder, so a leash — not a catch — is what ends a chase),
//!     or when the target stays beyond `LOSE_RADIUS` for `LOSE_GRACE_SECS` → Return.
//!   * **Return** — path back to the home post and steer home, *ignoring* the
//!     intruder until it arrives (no mid-return re-acquire, which would yo-yo the
//!     guard at the leash edge); arrive within `HOME_ARRIVE_RADIUS` → Patrol, where
//!     detection resumes normally.
//!
//! **Feel notes:** The detection is pure proximity (no vision cone / line-of-sight
//! occlusion) — so the guard "senses" the intruder through walls, which reads as
//! slightly omniscient. That is a deliberate scope trim (a cone + LOS ray is a pure
//! additive follow-up, noted in the PR) kept out so the headless proof stays about
//! the FSM, not occlusion geometry. The chase itself feels *alive* compared to s14:
//! steering's `arrive` easing means the guard decelerates onto the intruder instead
//! of stopping dead, and the `LOSE_RADIUS > DETECT_RADIUS` hysteresis stops the
//! state from flickering at the edge. The honest rough edge: steering follows the
//! navmesh waypoints, which hug obstacle corners, so on tight corners the guard
//! visibly clips the corner slightly before snapping back onto the path (steering
//! is approximate by nature — the navmesh polyline is the safe one, the steered
//! trajectory only tracks it). Obstacle `avoid` is applied to *free* movement
//! (patrol / detect beeline) but NOT to path-following, because the navmesh path is
//! already provably obstacle-free and a repulsion field fighting a corner-hugging
//! waypoint would stall the guard.
//!
//! **Bevy 0.18 gotchas:**
//!   * Meshes spawn as `Mesh3d(handle)` + `MeshMaterial3d(handle)` — no
//!     `PbrBundle`. Scoped cleanup is `DespawnOnExit(state)`, not `StateScoped`.
//!   * The guard and intruder are separate entities, so their `&mut Transform`
//!     writes live in **separate** chained systems (Bevy rejects two `&mut
//!     Transform` queries in one system even with disjoint `With` filters).
//!   * `Gizmos` debug drawing needs `DefaultPlugins`; the headless `cargo test`
//!     path runs the pure core directly (no `App`, no gizmos) — all the proof lives
//!     in the render-independent FSM/steering functions, never the draw systems.
//!   * Nav-space `Vec2(x, y)` maps to world `Vec3(x, height, y)` via
//!     `nav::to_world` (nav-space Y becomes world Z).

use bevy::prelude::*;

use crate::engine::nav::{self, BlockedAabb};
use crate::engine::{hud, scene};

use super::{AppState, SampleMeta};

pub const META: SampleMeta = SampleMeta {
    id: "16-guard-ai",
    title: "Guard AI (FSM patrol/detect/chase/return)",
    summary: "Hand-rolled FSM + steering guard that patrols, detects an intruder, chases via navmesh, and returns.",
    tags: &["ai", "fsm", "steering", "navmesh", "npc"],
};

// ============================================================================
// Tuning constants (shared by the pure core and the visualization)
// ============================================================================

/// Half-extent of the square field: the outer boundary is `±FIELD_HALF`.
const FIELD_HALF: f32 = 9.0;
/// Centre of the single static obstacle (straddles the field so a chase across
/// it must detour — exercising the navmesh path + waypoint advance).
const OBSTACLE_CENTER: Vec2 = Vec2::new(2.0, 0.0);
/// Half-size of the square obstacle block.
const OBSTACLE_HALF: f32 = 1.5;

// Steering speeds (world units / second).
/// Relaxed patrol cruise.
const PATROL_SPEED: f32 = 2.5;
/// Cautious creep while confirming a detection.
const DETECT_SPEED: f32 = 1.5;
/// Full speed while chasing or returning.
const CHASE_SPEED: f32 = 5.0;

/// Distance at which `arrive` starts easing the speed down to zero.
const ARRIVE_SLOW_RADIUS: f32 = 1.5;
/// How close (world units) counts as "reached" a path/patrol waypoint — the leg
/// index advances once inside this.
const WAYPOINT_ARRIVE_RADIUS: f32 = 0.6;
/// Radius around an obstacle within which the avoid repulsion acts.
const AVOID_RADIUS: f32 = 2.2;
/// Strength of the obstacle avoid repulsion (added to the desired velocity).
const AVOID_STRENGTH: f32 = 6.0;

// FSM thresholds.
/// Intruder within this distance is detected.
const DETECT_RADIUS: f32 = 4.5;
/// Seconds the intruder must stay detected before the guard commits to a chase.
const DETECT_CONFIRM_SECS: f32 = 0.3;
/// Chase leash: if the chase pulls the guard farther than this from its home
/// post, it gives up and returns. This is the *primary* give-up trigger — the
/// guard is faster than the intruder, so without a leash it could chase a lured
/// target forever. Must exceed the farthest reachable chase point inside the
/// field that we still want the guard to commit to.
const CHASE_LEASH: f32 = 13.0;
/// Secondary give-up: intruder beyond this distance (hysteresis: > `DETECT_RADIUS`)
/// for `LOSE_GRACE_SECS` is lost — covers a target that genuinely escapes far.
const LOSE_RADIUS: f32 = 10.0;
/// Seconds beyond `LOSE_RADIUS` before the secondary give-up fires.
const LOSE_GRACE_SECS: f32 = 0.5;
/// Seconds between chase re-paths to the intruder's current position.
const REPATH_SECS: f32 = 0.4;
/// How close to the home post counts as "returned".
const HOME_ARRIVE_RADIUS: f32 = 0.8;

// ============================================================================
// Pure AI core (render-independent, headless-testable)
// ============================================================================

/// The guard's finite-state-machine state. Plain data — no ECS, no rendering.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GuardState {
    Patrol,
    Detect,
    Chase,
    Return,
}

/// An axis-aligned square obstacle centred at `center` with half-extent `half`.
fn block(center: Vec2, half: f32) -> BlockedAabb {
    BlockedAabb::new(center - Vec2::splat(half), center + Vec2::splat(half))
}

/// Build the counter-clockwise outer boundary of the square field.
fn field_boundary() -> Vec<Vec2> {
    vec![
        Vec2::new(-FIELD_HALF, -FIELD_HALF),
        Vec2::new(FIELD_HALF, -FIELD_HALF),
        Vec2::new(FIELD_HALF, FIELD_HALF),
        Vec2::new(-FIELD_HALF, FIELD_HALF),
    ]
}

/// The guard's patrol loop (a rectangle in the open left half of the field, clear
/// of the obstacle). Also the source of the home post (`patrol[0]`).
fn patrol_loop() -> Vec<Vec2> {
    vec![
        Vec2::new(-5.0, -3.0),
        Vec2::new(-5.0, 3.0),
        Vec2::new(-1.0, 3.0),
        Vec2::new(-1.0, -3.0),
    ]
}

/// The flat-navmesh scenario the chase/return path queries run against: a fixed
/// outer boundary and the static obstacle set. Mirrors s14's `NavScenario` query
/// half (it reuses the very same `engine::nav` foundation), minus the dynamic
/// obstacle this sample does not need.
struct GuardScenario {
    outer: Vec<Vec2>,
    obstacles: Vec<BlockedAabb>,
}

impl GuardScenario {
    fn sample() -> Self {
        Self {
            outer: field_boundary(),
            obstacles: vec![block(OBSTACLE_CENTER, OBSTACLE_HALF)],
        }
    }

    /// Query a route `from → to` over the obstacle set, returning the full
    /// traversed polyline **including the start point** (so the first leg is
    /// subject to the same checks as the rest), or `None` if unreachable. Same
    /// shape as s14's `NavScenario::route` — built on `engine::nav`, not reinvented.
    fn route(&self, from: Vec2, to: Vec2) -> Option<Vec<Vec2>> {
        let navmesh = nav::build_flat_navmesh(&self.outer, &self.obstacles);
        let path = nav::find_path(&navmesh, from, to)?;
        let mut poly = Vec::with_capacity(path.path.len() + 1);
        poly.push(from);
        poly.extend(path.path.iter().copied());
        Some(poly)
    }
}

/// The mutable guard agent: kinematic body + FSM bookkeeping. Pure data driven by
/// [`tick`]; the ECS layer mirrors `pos`/`state`/`path` into the scene.
struct Guard {
    pos: Vec2,
    vel: Vec2,
    state: GuardState,
    patrol: Vec<Vec2>,
    patrol_leg: usize,
    home: Vec2,
    /// Current chase/return navmesh path (empty while patrolling).
    path: Vec<Vec2>,
    path_leg: usize,
    detect_timer: f32,
    lose_timer: f32,
    repath_timer: f32,
}

impl Guard {
    /// A guard starting at its home post, patrolling.
    fn sample() -> Self {
        let patrol = patrol_loop();
        let home = patrol[0];
        Self {
            pos: home,
            vel: Vec2::ZERO,
            state: GuardState::Patrol,
            patrol,
            patrol_leg: 1, // head toward the next corner, not the one we're on
            home,
            path: Vec::new(),
            path_leg: 0,
            detect_timer: 0.0,
            lose_timer: 0.0,
            repath_timer: 0.0,
        }
    }
}

// --- Steering primitives (hand-rolled seek / arrive / avoid) -----------------

/// Seek: desired velocity pointing straight at `target`, at full `max_speed`.
fn seek(pos: Vec2, target: Vec2, max_speed: f32) -> Vec2 {
    let to = target - pos;
    let d = to.length();
    if d <= f32::EPSILON {
        Vec2::ZERO
    } else {
        to / d * max_speed
    }
}

/// Arrive: like [`seek`] but eases the speed linearly to zero inside `slow_radius`
/// so the agent decelerates onto the target instead of overshooting.
fn arrive(pos: Vec2, target: Vec2, max_speed: f32, slow_radius: f32) -> Vec2 {
    let to = target - pos;
    let d = to.length();
    if d <= f32::EPSILON {
        return Vec2::ZERO;
    }
    let speed = if d < slow_radius {
        max_speed * (d / slow_radius)
    } else {
        max_speed
    };
    to / d * speed
}

/// The point on (or in) an AABB closest to `p` — `p` clamped to the box.
fn closest_point_on_aabb(p: Vec2, aabb: &BlockedAabb) -> Vec2 {
    Vec2::new(p.x.clamp(aabb.min.x, aabb.max.x), p.y.clamp(aabb.min.y, aabb.max.y))
}

/// Avoid: summed inverse-distance repulsion away from every obstacle within
/// `radius`. Zero when clear of all obstacles. Applied to *free* movement only
/// (patrol / detect beeline), never to navmesh path-following.
fn avoid(pos: Vec2, obstacles: &[BlockedAabb], radius: f32, strength: f32) -> Vec2 {
    let mut push = Vec2::ZERO;
    for o in obstacles {
        let closest = closest_point_on_aabb(pos, o);
        let away = pos - closest;
        let d = away.length();
        if d > f32::EPSILON && d < radius {
            // Falls off linearly to zero at the edge of the avoid radius.
            push += away / d * (strength * (1.0 - d / radius));
        }
    }
    push
}

/// Integrate one kinematic step: clamp `desired` to `cap` and advance `pos`.
fn integrate(guard: &mut Guard, desired: Vec2, cap: f32, dt: f32) {
    let mut v = desired;
    let speed = v.length();
    if speed > cap {
        v = v / speed * cap;
    }
    guard.vel = v;
    guard.pos += v * dt;
}

/// Free movement: steer with `desired` plus obstacle avoidance, then integrate.
fn free_move(guard: &mut Guard, desired: Vec2, obstacles: &[BlockedAabb], cap: f32, dt: f32) {
    let push = avoid(guard.pos, obstacles, AVOID_RADIUS, AVOID_STRENGTH);
    integrate(guard, desired + push, cap, dt);
}

/// Walk one patrol step: advance the patrol leg when the current corner is
/// reached (looping), then steer toward the active corner with avoidance.
fn patrol_step(guard: &mut Guard, obstacles: &[BlockedAabb], dt: f32) {
    if guard.patrol.is_empty() {
        return;
    }
    if guard.pos.distance(guard.patrol[guard.patrol_leg]) <= WAYPOINT_ARRIVE_RADIUS {
        guard.patrol_leg = (guard.patrol_leg + 1) % guard.patrol.len();
    }
    let aim = guard.patrol[guard.patrol_leg];
    let desired = seek(guard.pos, aim, PATROL_SPEED);
    free_move(guard, desired, obstacles, PATROL_SPEED, dt);
}

/// Steer along the current navmesh `path`: advance past reached waypoints, then
/// seek the active one (arrive-ease onto the final one). No obstacle avoid — the
/// navmesh polyline is already obstacle-free, so repulsion would only fight the
/// corner-hugging waypoints.
fn follow_path(guard: &mut Guard, dt: f32) {
    while guard.path_leg < guard.path.len()
        && guard.pos.distance(guard.path[guard.path_leg]) <= WAYPOINT_ARRIVE_RADIUS
    {
        guard.path_leg += 1;
    }
    if guard.path.is_empty() {
        return;
    }
    let last_index = guard.path.len() - 1;
    let idx = guard.path_leg.min(last_index);
    let target = guard.path[idx];
    let desired = if idx == last_index {
        arrive(guard.pos, target, CHASE_SPEED, ARRIVE_SLOW_RADIUS)
    } else {
        seek(guard.pos, target, CHASE_SPEED)
    };
    integrate(guard, desired, CHASE_SPEED, dt);
}

/// Advance the guard one tick against the intruder at `player`. Returns the new
/// state **iff a transition fired** this tick (for the headless transition log).
///
/// This is the whole FSM — pure, deterministic, render-free.
fn tick(guard: &mut Guard, player: Vec2, scenario: &GuardScenario, dt: f32) -> Option<GuardState> {
    let prev = guard.state;
    let dist = guard.pos.distance(player);

    match guard.state {
        GuardState::Patrol => {
            patrol_step(guard, &scenario.obstacles, dt);
            if dist <= DETECT_RADIUS {
                guard.detect_timer = 0.0;
                guard.state = GuardState::Detect;
            }
        }
        GuardState::Detect => {
            // Creep toward the intruder while confirming.
            let desired = arrive(guard.pos, player, DETECT_SPEED, ARRIVE_SLOW_RADIUS);
            free_move(guard, desired, &scenario.obstacles, DETECT_SPEED, dt);
            if dist > DETECT_RADIUS {
                guard.state = GuardState::Patrol; // false alarm
            } else {
                guard.detect_timer += dt;
                if guard.detect_timer >= DETECT_CONFIRM_SECS {
                    repath_to(guard, scenario, player);
                    guard.repath_timer = 0.0;
                    guard.lose_timer = 0.0;
                    guard.state = GuardState::Chase;
                }
            }
        }
        GuardState::Chase => {
            guard.repath_timer += dt;
            if guard.repath_timer >= REPATH_SECS {
                guard.repath_timer = 0.0;
                repath_to(guard, scenario, player);
            }
            if guard.path.is_empty() {
                // Path query failed (target momentarily unreachable): fall back to
                // a direct avoided seek so the guard keeps closing instead of
                // soft-locking on an empty path.
                let desired = seek(guard.pos, player, CHASE_SPEED);
                free_move(guard, desired, &scenario.obstacles, CHASE_SPEED, dt);
            } else {
                follow_path(guard, dt);
            }
            // Primary give-up: lured too far from the post (leash).
            let leashed = guard.pos.distance(guard.home) > CHASE_LEASH;
            // Secondary give-up: target out of range long enough.
            if dist > LOSE_RADIUS {
                guard.lose_timer += dt;
            } else {
                guard.lose_timer = 0.0;
            }
            if leashed || guard.lose_timer >= LOSE_GRACE_SECS {
                repath_to(guard, scenario, guard.home);
                guard.state = GuardState::Return;
            }
        }
        GuardState::Return => {
            // Committed to returning: walk home ignoring the intruder until the
            // post is reached (no mid-return re-acquire, which would yo-yo the
            // guard at the leash edge); detection resumes once patrolling.
            follow_path(guard, dt);
            if guard.pos.distance(guard.home) <= HOME_ARRIVE_RADIUS {
                guard.path.clear();
                guard.path_leg = 0;
                guard.state = GuardState::Patrol;
            }
        }
    }

    (guard.state != prev).then_some(guard.state)
}

/// Re-query a route to `goal` and reset the path/leg. Keeps the old path if the
/// goal is momentarily unreachable (so the guard at least keeps moving).
fn repath_to(guard: &mut Guard, scenario: &GuardScenario, goal: Vec2) {
    if let Some(route) = scenario.route(guard.pos, goal) {
        guard.path = route;
        guard.path_leg = 0;
    }
}

// ============================================================================
// ECS visualization (gated on AppState::S16GuardAi)
// ============================================================================

/// Visualization constants.
const GIZMO_Y: f32 = 0.05;
const OBSTACLE_HEIGHT: f32 = 2.0;
const AGENT_RADIUS: f32 = 0.4;
const AGENT_HALF_HEIGHT: f32 = 0.5;
const PATROL_MARKER_RADIUS: f32 = 0.18;
const CAM_HEIGHT: f32 = 28.0;
const CAM_Z_NUDGE: f32 = 0.01;
const DETECT_RING_SEGMENTS: usize = 48;

const COLOR_BOUNDARY: Color = Color::srgb(0.9, 0.9, 0.9);
const COLOR_OBSTACLE: Color = Color::srgb(0.85, 0.25, 0.25);
const COLOR_PATH: Color = Color::srgb(0.2, 0.85, 0.9);
const COLOR_PATROL: Color = Color::srgb(0.55, 0.55, 0.6);
const COLOR_INTRUDER: Color = Color::srgb(0.9, 0.2, 0.2);
const COLOR_RING: Color = Color::srgb(0.95, 0.85, 0.3);
// Guard tint per state (also drives the state-label colour).
const COLOR_PATROL_STATE: Color = Color::srgb(0.3, 0.7, 0.4);
const COLOR_DETECT_STATE: Color = Color::srgb(0.9, 0.8, 0.2);
const COLOR_CHASE_STATE: Color = Color::srgb(0.95, 0.35, 0.2);
const COLOR_RETURN_STATE: Color = Color::srgb(0.4, 0.6, 0.95);

/// Marker for the guard capsule.
#[derive(Component)]
struct GuardAvatar;

/// Marker for the scripted intruder capsule.
#[derive(Component)]
struct Intruder;

/// Marker for the state-label text.
#[derive(Component)]
struct StateLabel;

/// Per-sample world: the pure scenario + guard, the scripted intruder driver, and
/// the guard material handle (re-tinted per state).
#[derive(Resource)]
struct GuardWorld {
    scenario: GuardScenario,
    guard: Guard,
    player: Vec2,
    player_path: Vec<Vec2>,
    player_leg: usize,
    guard_material: Handle<StandardMaterial>,
}

/// The intruder's scripted loop: lurk far away, dive into the patrol area (trips
/// detect→chase), cross to the obstacle's far side (forces a routed chase), then
/// flee back out (trips return). Loops forever so the demo self-cycles.
fn intruder_loop() -> Vec<Vec2> {
    vec![
        Vec2::new(8.0, -8.0),  // far lurk
        Vec2::new(-3.0, 0.0),  // dive into patrol → detect/chase
        Vec2::new(6.0, 0.0),   // cross the obstacle → routed chase
        Vec2::new(8.0, 8.0),   // flee → lose → return
    ]
}

/// Intruder cruise speed (world units / second) along its scripted loop.
const INTRUDER_SPEED: f32 = 3.0;

pub struct GuardAiPlugin;

impl Plugin for GuardAiPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(OnEnter(AppState::S16GuardAi), setup).add_systems(
            Update,
            (drive_intruder, think_guard, update_visuals, draw_nav)
                .chain()
                .run_if(in_state(AppState::S16GuardAi)),
        );
    }
}

fn setup(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    let state = AppState::S16GuardAi;
    let scope = DespawnOnExit(state);

    scene::spawn_ground(&mut commands, &mut meshes, &mut materials, state);
    scene::spawn_light_preset(&mut commands, state);

    let scenario = GuardScenario::sample();
    let guard = Guard::sample();

    // Obstacle box (red).
    spawn_obstacle_box(&mut commands, &mut meshes, &mut materials, scenario.obstacles[0], scope.clone());

    // Patrol corner markers (grey spheres) so the loop is visible.
    let patrol_marker_mesh = meshes.add(Sphere::new(PATROL_MARKER_RADIUS));
    let patrol_marker_mat = materials.add(StandardMaterial {
        base_color: COLOR_PATROL,
        ..default()
    });
    for corner in &guard.patrol {
        commands.spawn((
            Mesh3d(patrol_marker_mesh.clone()),
            MeshMaterial3d(patrol_marker_mat.clone()),
            Transform::from_translation(nav::to_world(*corner, PATROL_MARKER_RADIUS)),
            scope.clone(),
        ));
    }

    // Guard capsule — keep its material handle so we can re-tint it per state.
    let guard_material = materials.add(StandardMaterial {
        base_color: COLOR_PATROL_STATE,
        ..default()
    });
    commands.spawn((
        GuardAvatar,
        Mesh3d(meshes.add(Capsule3d::new(AGENT_RADIUS, AGENT_HALF_HEIGHT * 2.0))),
        MeshMaterial3d(guard_material.clone()),
        Transform::from_translation(nav::to_world(guard.pos, AGENT_RADIUS + AGENT_HALF_HEIGHT)),
        scope.clone(),
    ));

    // Scripted intruder capsule (red).
    let player_path = intruder_loop();
    let player = player_path[0];
    commands.spawn((
        Intruder,
        Mesh3d(meshes.add(Capsule3d::new(AGENT_RADIUS, AGENT_HALF_HEIGHT * 2.0))),
        MeshMaterial3d(materials.add(StandardMaterial {
            base_color: COLOR_INTRUDER,
            ..default()
        })),
        Transform::from_translation(nav::to_world(player, AGENT_RADIUS + AGENT_HALF_HEIGHT)),
        scope.clone(),
    ));

    // Top-down camera.
    commands.spawn((
        Camera3d::default(),
        Transform::from_xyz(0.0, CAM_HEIGHT, CAM_Z_NUDGE).looking_at(Vec3::ZERO, Vec3::Y),
        scope.clone(),
    ));

    // State label (top-left).
    commands.spawn((
        StateLabel,
        DespawnOnExit(state),
        Text::new("State: Patrol"),
        TextFont {
            font_size: 20.0,
            ..default()
        },
        TextColor(COLOR_PATROL_STATE),
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
            "Auto: an intruder loops in and out of range",
            "Guard: patrol -> detect -> chase -> return",
            "Esc — back to menu",
        ],
    );
    hud::spawn_fps_counter(&mut commands, state);

    commands.insert_resource(GuardWorld {
        scenario,
        guard,
        player,
        player_path,
        player_leg: 1,
        guard_material,
    });
}

/// Spawn a box visualizing a [`BlockedAabb`] (centred, sized to it, standing tall).
fn spawn_obstacle_box(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    materials: &mut Assets<StandardMaterial>,
    aabb: BlockedAabb,
    scope: DespawnOnExit<AppState>,
) {
    let size = aabb.max - aabb.min;
    let center = (aabb.min + aabb.max) * 0.5;
    commands.spawn((
        Mesh3d(meshes.add(Cuboid::new(size.x, OBSTACLE_HEIGHT, size.y))),
        MeshMaterial3d(materials.add(StandardMaterial {
            base_color: COLOR_OBSTACLE,
            ..default()
        })),
        Transform::from_translation(nav::to_world(center, OBSTACLE_HEIGHT * 0.5)),
        scope,
    ));
}

/// Drive the scripted intruder along its loop and mirror it into the scene.
fn drive_intruder(time: Res<Time>, mut world: ResMut<GuardWorld>, mut q: Query<&mut Transform, With<Intruder>>) {
    let dt = time.delta_secs();
    // Step toward the current loop waypoint; advance (looping) when reached.
    let target = world.player_path[world.player_leg];
    let to = target - world.player;
    let dist = to.length();
    let step = INTRUDER_SPEED * dt;
    if dist <= step.max(WAYPOINT_ARRIVE_RADIUS) {
        world.player = target;
        world.player_leg = (world.player_leg + 1) % world.player_path.len();
    } else {
        world.player += to / dist * step;
    }
    if let Ok(mut tf) = q.single_mut() {
        tf.translation = nav::to_world(world.player, AGENT_RADIUS + AGENT_HALF_HEIGHT);
    }
}

/// Run the FSM core one tick and mirror the guard position into the scene.
fn think_guard(time: Res<Time>, mut world: ResMut<GuardWorld>, mut q: Query<&mut Transform, With<GuardAvatar>>) {
    let dt = time.delta_secs();
    let player = world.player;
    let GuardWorld { scenario, guard, .. } = &mut *world;
    if let Some(new_state) = tick(guard, player, scenario, dt) {
        info!("s16 guard: -> {new_state:?}");
    }
    if let Ok(mut tf) = q.single_mut() {
        tf.translation = nav::to_world(world.guard.pos, AGENT_RADIUS + AGENT_HALF_HEIGHT);
    }
}

/// Re-tint the guard and refresh the state label to match the current state.
fn update_visuals(
    world: Res<GuardWorld>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut label: Query<(&mut Text, &mut TextColor), With<StateLabel>>,
) {
    let (name, color) = match world.guard.state {
        GuardState::Patrol => ("Patrol", COLOR_PATROL_STATE),
        GuardState::Detect => ("Detect", COLOR_DETECT_STATE),
        GuardState::Chase => ("Chase", COLOR_CHASE_STATE),
        GuardState::Return => ("Return", COLOR_RETURN_STATE),
    };
    if let Some(mat) = materials.get_mut(&world.guard_material) {
        mat.base_color = color;
    }
    if let Ok((mut text, mut text_color)) = label.single_mut() {
        **text = format!("State: {name}");
        text_color.0 = color;
    }
}

/// Gizmo debug: boundary, obstacle, patrol loop, detection ring, and the guard's
/// live chase/return path. Visualization only — never runs under the headless tests.
fn draw_nav(mut gizmos: Gizmos, world: Res<GuardWorld>) {
    nav::draw_polygon(&mut gizmos, &world.scenario.outer, GIZMO_Y, COLOR_BOUNDARY);
    for obstacle in &world.scenario.obstacles {
        nav::draw_polygon(&mut gizmos, &obstacle.polygon(), GIZMO_Y, COLOR_OBSTACLE);
    }
    nav::draw_polygon(&mut gizmos, &world.guard.patrol, GIZMO_Y, COLOR_PATROL);
    if !world.guard.path.is_empty() {
        nav::draw_path(&mut gizmos, &world.guard.path, GIZMO_Y, COLOR_PATH);
    }
    draw_ring(&mut gizmos, world.guard.pos, DETECT_RADIUS, COLOR_RING);
}

/// Draw a debug circle on the XZ plane (the guard's detection radius).
fn draw_ring(gizmos: &mut Gizmos, center: Vec2, radius: f32, color: Color) {
    let mut prev = center + Vec2::new(radius, 0.0);
    for i in 1..=DETECT_RING_SEGMENTS {
        let a = i as f32 / DETECT_RING_SEGMENTS as f32 * std::f32::consts::TAU;
        let next = center + Vec2::new(radius * a.cos(), radius * a.sin());
        gizmos.line(nav::to_world(prev, GIZMO_Y), nav::to_world(next, GIZMO_Y), color);
        prev = next;
    }
}

// ============================================================================
// Headless tests (pure core — no App, no GPU, no gizmos)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// Fixed timestep for the simulated drives (matches a 60 Hz tick).
    const DT: f32 = 1.0 / 60.0;
    /// Closest-approach threshold for "the guard caught the intruder".
    const CATCH_RADIUS: f32 = 1.3;

    /// Drives the pure FSM core and records every transition (in order) plus the
    /// chase-progress evidence the asserts need.
    struct Sim {
        guard: Guard,
        scenario: GuardScenario,
        transitions: Vec<GuardState>,
        max_chase_leg: usize,
        saw_chase_path: bool,
        min_chase_dist: f32,
    }

    impl Sim {
        fn new() -> Self {
            Self {
                guard: Guard::sample(),
                scenario: GuardScenario::sample(),
                transitions: Vec::new(),
                max_chase_leg: 0,
                saw_chase_path: false,
                min_chase_dist: f32::INFINITY,
            }
        }

        /// Hold the intruder at `player` for one tick, recording any transition and
        /// chase evidence. Returns the resulting state.
        fn step(&mut self, player: Vec2) -> GuardState {
            if let Some(s) = tick(&mut self.guard, player, &self.scenario, DT) {
                self.transitions.push(s);
            }
            if self.guard.state == GuardState::Chase {
                if self.guard.path.len() >= 2 {
                    self.saw_chase_path = true;
                }
                self.max_chase_leg = self.max_chase_leg.max(self.guard.path_leg);
                self.min_chase_dist = self.min_chase_dist.min(self.guard.pos.distance(player));
            }
            self.guard.state
        }

        /// Hold the intruder at `player` for exactly `ticks` ticks.
        fn hold(&mut self, player: Vec2, ticks: usize) {
            for _ in 0..ticks {
                self.step(player);
            }
        }

        /// Hold the intruder at `player` until the guard reaches `want`, up to
        /// `cap` ticks. Returns the number of ticks taken; `None` if it never did.
        fn run_until(&mut self, player: Vec2, want: GuardState, cap: usize) -> Option<usize> {
            (0..cap).find(|_| self.step(player) == want)
        }
    }

    /// The patrol loop is stable when no intruder is near: held alone for two
    /// seconds the guard stays in Patrol and fires no transitions (non-vacuous:
    /// proves detection is not spuriously tripping).
    #[test]
    fn patrol_is_stable_without_intruder() {
        let mut sim = Sim::new();
        sim.hold(Vec2::new(8.0, -8.0), 120);
        assert_eq!(sim.guard.state, GuardState::Patrol, "guard should stay patrolling when alone");
        assert!(
            sim.transitions.is_empty(),
            "no transitions expected while patrolling alone, got {:?}",
            sim.transitions
        );
    }

    /// The full FSM cycle fires in the expected order within tick budgets:
    /// patrol → detect → chase → return → patrol. Also pins the chase evidence
    /// (waypoint leg advances on a non-empty path; closest approach < threshold).
    #[test]
    fn fsm_cycles_patrol_detect_chase_return_in_order() {
        let mut sim = Sim::new();

        // 1) Alone: patrolling, no transitions yet.
        sim.hold(Vec2::new(8.0, -8.0), 60);
        assert_eq!(sim.guard.state, GuardState::Patrol);
        assert!(sim.transitions.is_empty(), "should not have transitioned while alone");

        // 2) Intruder dives into the patrol area → detect, then chase.
        let lure = Vec2::new(-3.0, 0.0);
        let to_chase = sim.run_until(lure, GuardState::Chase, 600);
        assert!(to_chase.is_some(), "guard should start chasing within budget after intruder appears");

        // 3) Intruder crosses to the obstacle's far side → routed chase; the guard
        //    closes to within catch range.
        let cross = Vec2::new(6.0, 0.0);
        let caught = sim.run_until_close(cross, CATCH_RADIUS, 1200);
        assert!(caught, "guard should close to within {CATCH_RADIUS} of the intruder during chase");

        // 4) Intruder flees far → guard loses it and returns.
        let flee = Vec2::new(8.0, 8.0);
        let to_return = sim.run_until(flee, GuardState::Return, 1200);
        assert!(to_return.is_some(), "guard should give up and return after the intruder flees");

        // 5) Left alone, the guard makes it home and resumes patrol.
        let to_patrol = sim.run_until(flee, GuardState::Patrol, 2000);
        assert!(to_patrol.is_some(), "guard should reach home and resume patrol");

        // --- Order + non-vacuous chase evidence ---
        assert!(!sim.transitions.is_empty(), "transition log must not be empty");
        let order = transition_order(&sim.transitions);
        let d = order(GuardState::Detect);
        let c = order(GuardState::Chase);
        let r = order(GuardState::Return);
        assert!(d.is_some() && c.is_some() && r.is_some(), "detect, chase and return must all fire: {:?}", sim.transitions);
        assert!(d < c, "detect must fire before chase: {:?}", sim.transitions);
        assert!(c < r, "chase must fire before return: {:?}", sim.transitions);

        assert!(sim.saw_chase_path, "a non-empty chase path must have been queried (else leg assert is vacuous)");
        assert!(sim.max_chase_leg >= 1, "the chase path waypoint index must advance past the start during chase");
        assert!(
            sim.min_chase_dist < CATCH_RADIUS,
            "closest chase approach {} should drop below the catch threshold {CATCH_RADIUS}",
            sim.min_chase_dist
        );
    }

    /// A brief intrusion that leaves before the confirm timer elapses is a false
    /// alarm: the guard dips into Detect but falls back to Patrol without chasing.
    #[test]
    fn brief_intrusion_is_a_false_alarm_no_chase() {
        let mut sim = Sim::new();
        // Approach close enough to detect for a couple of ticks (< confirm time)...
        let near = sim.guard.pos + Vec2::new(DETECT_RADIUS * 0.5, 0.0);
        sim.hold(near, 2);
        assert_eq!(sim.guard.state, GuardState::Detect, "a near intruder should trip Detect");
        // ...then leave immediately.
        sim.hold(Vec2::new(8.0, -8.0), 60);
        assert_eq!(sim.guard.state, GuardState::Patrol, "guard should fall back to Patrol after a false alarm");
        assert!(
            !sim.transitions.contains(&GuardState::Chase),
            "a sub-confirm intrusion must not escalate to Chase: {:?}",
            sim.transitions
        );
    }

    /// Closest-approach driver: like `run_until` but the success condition is
    /// proximity to the intruder rather than a state.
    impl Sim {
        fn run_until_close(&mut self, player: Vec2, radius: f32, cap: usize) -> bool {
            for _ in 0..cap {
                self.step(player);
                if self.guard.pos.distance(player) <= radius {
                    return true;
                }
            }
            false
        }
    }

    /// Returns a lookup giving the first index a state appears at in the log.
    fn transition_order(log: &[GuardState]) -> impl Fn(GuardState) -> Option<usize> + '_ {
        move |s| log.iter().position(|x| *x == s)
    }

    /// Steering sanity: `arrive` eases toward zero speed near the target while
    /// `seek` does not (so the guard decelerates onto the intruder, not past it).
    #[test]
    fn arrive_eases_inside_slow_radius() {
        let pos = Vec2::ZERO;
        let target = Vec2::new(ARRIVE_SLOW_RADIUS * 0.25, 0.0); // well inside slow radius
        let arrive_v = arrive(pos, target, CHASE_SPEED, ARRIVE_SLOW_RADIUS).length();
        let seek_v = seek(pos, target, CHASE_SPEED).length();
        assert!(arrive_v < seek_v, "arrive ({arrive_v}) should be slower than seek ({seek_v}) inside the slow radius");
        assert!(arrive_v > 0.0, "arrive should still creep toward the target");
    }

    /// Steering sanity: `avoid` pushes away from an obstacle the agent is next to,
    /// and is zero when the agent is clear of every obstacle.
    #[test]
    fn avoid_repels_near_obstacle_and_is_zero_when_clear() {
        let obstacles = [block(OBSTACLE_CENTER, OBSTACLE_HALF)];
        // Just left of the obstacle's left face, inside the avoid radius.
        let near = Vec2::new(OBSTACLE_CENTER.x - OBSTACLE_HALF - 0.3, OBSTACLE_CENTER.y);
        let push = avoid(near, &obstacles, AVOID_RADIUS, AVOID_STRENGTH);
        assert!(push.length() > 0.0, "avoid should repel near an obstacle");
        assert!(push.x < 0.0, "repulsion should point away from the obstacle (to the left)");

        let far = Vec2::new(-FIELD_HALF, -FIELD_HALF);
        assert_eq!(avoid(far, &obstacles, AVOID_RADIUS, AVOID_STRENGTH), Vec2::ZERO, "avoid is zero when clear");
    }
}
