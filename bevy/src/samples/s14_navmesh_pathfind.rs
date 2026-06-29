//! # s14 — Navmesh pathfinding with dynamic-obstacle re-path
//!
//! **What it demonstrates:** An agent path-finds A→B across a flat navmesh
//! (vleue_navigator / Polyanya, the Ch4 nav foundation), walks the returned
//! polyline, and — when a **dynamic obstacle** drops onto its route a few
//! seconds in — the navmesh is **re-baked** and the path is **re-queried** from
//! the agent's current position, so it re-routes around the new wall on the fly.
//! This is the first Ch4 (NPC/AI) sample: the navmesh *query* half of NPC
//! locomotion (the steering/FSM halves are samples 15/16). The pure path logic
//! (`NavScenario` + [`advance`]) is render-independent and headless-tested; the
//! ECS half here is pure visualization (top-down camera, gizmo navmesh debug,
//! agent capsule, obstacle boxes).
//!
//! **Controls:** None — it runs itself. The agent auto-walks from the blue start
//! to the green goal; after [`DYNAMIC_DELAY_SECS`] a purple wall drops on its
//! path and it re-routes. `Esc` returns to the menu (auto-despawns everything).
//!
//! **Feel notes:** The re-path is *instant* — Polyanya's query is pure-CPU and
//! synchronous, so on a dynamic-obstacle drop the agent's line visibly snaps to a
//! new route within the same frame with zero hitch. That reads as "perfectly
//! omniscient AI": there is no reaction delay, no partial-knowledge wandering,
//! and no path-smoothing, so corners are hugged exactly (waypoints sit *on*
//! obstacle borders). Faithful to a navmesh query, but a shipping game would add
//! a reaction latency + corner rounding + steering (sample 15) so the motion
//! doesn't look robotic. The agent also stops dead at the goal (no arrive easing).
//!
//! **Determinism finding (the thing this sample exists to record):** re-baking
//! the navmesh from identical `(outer boundary + obstacle set)` inputs and
//! re-querying the same A→B is **run-to-run bit-stable within a process** — path
//! length and waypoint count are identical across repeated bakes (asserted in
//! [`tests::rebake_is_deterministic`]). So the *dynamic* re-path is fully
//! deterministic given fixed obstacle geometry: the drift the design warned about
//! (Polyanya-vs-Detour / float / WASM-init) is a *cross-implementation /
//! cross-platform* concern, NOT run-to-run noise. That is exactly why the
//! headless asserts are robust *properties* (reached / no-intrusion / re-routed),
//! never an exact point-sequence — see `engine/nav.rs` and `bevy/CLAUDE.md`.
//!
//! **Bevy 0.18 gotchas:**
//!   * Meshes spawn as `Mesh3d(handle)` + `MeshMaterial3d(handle)` — no
//!     `PbrBundle`. Scoped cleanup is `DespawnOnExit(state)`, not `StateScoped`.
//!   * `Gizmos` debug drawing needs `DefaultPlugins` (GizmoPlugin); the headless
//!     `cargo test` path runs `MinimalPlugins` and never touches gizmos — all the
//!     proof lives in the pure core, never the draw systems.
//!   * The navmesh is a flat XZ-plane field over a `y = 0` ground: nav-space
//!     `Vec2(x, y)` maps to world `Vec3(x, height, y)` via `nav::to_world`
//!     (nav-space Y becomes world Z; `height` lifts the marker off the ground).

use bevy::prelude::*;

use crate::engine::nav::{self, BlockedAabb};
use crate::engine::{hud, scene};

use super::{AppState, SampleMeta};

pub const META: SampleMeta = SampleMeta {
    id: "14-navmesh-pathfind",
    title: "Navmesh pathfinding (dynamic re-path)",
    summary: "Agent path-finds A→B over a navmesh and re-routes when a wall drops on its path.",
    tags: &["ai", "navmesh", "pathfinding", "polyanya"],
};

// --- Scenario geometry (nav-space Vec2, XZ plane) ---------------------------

/// Half-extent of the square field: the outer boundary is `±FIELD_HALF`.
const FIELD_HALF: f32 = 8.0;
/// Agent start corner (nav-space).
const START: Vec2 = Vec2::new(-6.0, -6.0);
/// Agent goal corner (nav-space).
const GOAL: Vec2 = Vec2::new(6.0, 6.0);
/// Half-size of each square obstacle block.
const BLOCK_HALF: f32 = 1.6;
/// Centre of the STATIC obstacle (present from the start, lower-left of centre,
/// straddling the A→B diagonal so the *initial* path is already a detour).
const STATIC_CENTER: Vec2 = Vec2::new(-2.0, -2.0);
/// Centre of the DYNAMIC obstacle (drops in at runtime, upper-right of centre,
/// on the post-detour route so it forces a *second* re-route).
const DYNAMIC_CENTER: Vec2 = Vec2::new(2.0, 2.0);

/// Seconds after entering the sample before the dynamic obstacle drops in.
const DYNAMIC_DELAY_SECS: f32 = 2.5;
/// Agent travel speed (world units / second) along the path polyline.
const AGENT_SPEED: f32 = 4.0;

// --- Visualization constants ------------------------------------------------

/// Y at which path/boundary gizmo lines are drawn (just above the ground).
const GIZMO_Y: f32 = 0.05;
/// Height of the obstacle boxes, and half-height for centering them on the
/// ground (`box center y = OBSTACLE_HEIGHT / 2`).
const OBSTACLE_HEIGHT: f32 = 2.0;
/// Capsule agent radius and total resting height offset.
const AGENT_RADIUS: f32 = 0.4;
const AGENT_HALF_HEIGHT: f32 = 0.5;
/// Radius of the goal marker sphere — shared by its mesh and its lift height so
/// the two can't drift apart.
const GOAL_MARKER_RADIUS: f32 = 0.35;
/// Top-down camera height and tiny Z nudge (so `up = +Y` is non-degenerate).
const CAM_HEIGHT: f32 = 26.0;
const CAM_Z_NUDGE: f32 = 0.01;

const COLOR_BOUNDARY: Color = Color::srgb(0.9, 0.9, 0.9);
const COLOR_STATIC: Color = Color::srgb(0.85, 0.25, 0.25);
const COLOR_DYNAMIC: Color = Color::srgb(0.65, 0.3, 0.85);
const COLOR_PATH: Color = Color::srgb(0.2, 0.85, 0.9);
const COLOR_AGENT: Color = Color::srgb(0.2, 0.5, 0.9);
const COLOR_GOAL: Color = Color::srgb(0.2, 0.85, 0.35);

// ============================================================================
// Pure path-logic core (render-independent, headless-testable)
// ============================================================================

/// Build the counter-clockwise outer boundary of the square field.
fn field_boundary() -> Vec<Vec2> {
    vec![
        Vec2::new(-FIELD_HALF, -FIELD_HALF),
        Vec2::new(FIELD_HALF, -FIELD_HALF),
        Vec2::new(FIELD_HALF, FIELD_HALF),
        Vec2::new(-FIELD_HALF, FIELD_HALF),
    ]
}

/// An axis-aligned square obstacle centred at `center` with half-extent `half`.
fn block(center: Vec2, half: f32) -> BlockedAabb {
    BlockedAabb::new(center - Vec2::splat(half), center + Vec2::splat(half))
}

/// A flat-navmesh scenario: a fixed outer boundary, a fixed set of static
/// obstacles, and an optional *dynamic* obstacle. Re-baking with the dynamic
/// obstacle present forces a different path — that is the whole mechanic.
///
/// Pure (no ECS, no GPU): the headless tests drive this directly; the ECS
/// systems below merely mirror its state into the scene.
struct NavScenario {
    outer: Vec<Vec2>,
    static_blocked: Vec<BlockedAabb>,
    dynamic: Option<BlockedAabb>,
}

impl NavScenario {
    /// The sample's scenario: the square field with one static block, no dynamic
    /// obstacle yet.
    fn sample() -> Self {
        Self {
            outer: field_boundary(),
            static_blocked: vec![block(STATIC_CENTER, BLOCK_HALF)],
            dynamic: None,
        }
    }

    /// All currently-active obstacles (static + dynamic if present).
    fn obstacles(&self) -> Vec<BlockedAabb> {
        let mut v = self.static_blocked.clone();
        v.extend(self.dynamic);
        v
    }

    /// Query A→B over the *current* obstacle set. Returns the full traversed
    /// polyline **including the start point** (`from` prepended to the Polyanya
    /// corner list), or `None` if the goal is unreachable. Prepending `from`
    /// makes the very first leg (start → first corner) subject to the same
    /// intrusion checks as every other leg.
    fn route(&self, from: Vec2, to: Vec2) -> Option<Vec<Vec2>> {
        let navmesh = nav::build_flat_navmesh(&self.outer, &self.obstacles());
        let path = nav::find_path(&navmesh, from, to)?;
        let mut poly = Vec::with_capacity(path.path.len() + 1);
        poly.push(from);
        poly.extend(path.path.iter().copied());
        Some(poly)
    }
}

/// Advance a point-agent along a waypoint polyline by `speed * dt`, consuming the
/// full movement budget across as many (possibly short) legs as it reaches this
/// tick. Returns the new `(position, leg)` where `leg` indexes the next waypoint
/// still ahead; `leg >= waypoints.len()` means the goal is reached.
///
/// Because the agent always heads straight at `waypoints[leg]` and snaps onto
/// each waypoint in turn, its true trajectory is *exactly* the polyline — so
/// proving the polyline avoids the obstacles proves the agent's motion does too.
fn advance(mut pos: Vec2, waypoints: &[Vec2], mut leg: usize, speed: f32, dt: f32) -> (Vec2, usize) {
    let mut budget = speed * dt;
    while leg < waypoints.len() && budget > 0.0 {
        let target = waypoints[leg];
        let to = target - pos;
        let dist = to.length();
        if dist <= budget {
            pos = target;
            leg += 1;
            budget -= dist;
        } else {
            pos += to / dist * budget;
            budget = 0.0;
        }
    }
    (pos, leg)
}

// ============================================================================
// ECS visualization (gated on AppState::S14NavmeshPathfind)
// ============================================================================

/// Per-sample nav state: the scenario plus the agent's live waypoint list and
/// re-path bookkeeping. Held as a resource so the obstacle/timer system and the
/// movement system share one source of truth.
#[derive(Resource)]
struct NavWorld {
    scenario: NavScenario,
    waypoints: Vec<Vec2>,
    leg: usize,
    drop_timer: Timer,
    dynamic_dropped: bool,
    repaths: u32,
}

/// Marker for the moving agent capsule (queried by the movement systems).
#[derive(Component)]
struct Agent;

pub struct NavmeshPathfindPlugin;

impl Plugin for NavmeshPathfindPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(OnEnter(AppState::S14NavmeshPathfind), setup)
            .add_systems(
                Update,
                (drop_dynamic_obstacle, move_agent, draw_nav)
                    .chain()
                    .run_if(in_state(AppState::S14NavmeshPathfind)),
            );
    }
}

fn setup(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    let state = AppState::S14NavmeshPathfind;
    let scope = DespawnOnExit(state);

    // Shared scene: big ground plane + key light (both DespawnOnExit-scoped).
    scene::spawn_ground(&mut commands, &mut meshes, &mut materials, state);
    scene::spawn_light_preset(&mut commands, state);

    // Pure core: build the scenario and the initial A→B route. `expect` guards
    // against a vacuous start (an unreachable goal would be a setup bug).
    let scenario = NavScenario::sample();
    let waypoints = scenario
        .route(START, GOAL)
        .expect("initial A->B route must exist on the open field");

    // Static obstacle box (red).
    spawn_obstacle_box(
        &mut commands,
        &mut meshes,
        &mut materials,
        scenario.static_blocked[0],
        COLOR_STATIC,
        scope.clone(),
    );

    // Agent capsule (blue), resting on the ground at the start corner.
    commands.spawn((
        Agent,
        Mesh3d(meshes.add(Capsule3d::new(AGENT_RADIUS, AGENT_HALF_HEIGHT * 2.0))),
        MeshMaterial3d(materials.add(StandardMaterial {
            base_color: COLOR_AGENT,
            ..default()
        })),
        Transform::from_translation(nav::to_world(START, AGENT_RADIUS + AGENT_HALF_HEIGHT)),
        scope.clone(),
    ));

    // Goal marker (green sphere).
    commands.spawn((
        Mesh3d(meshes.add(Sphere::new(GOAL_MARKER_RADIUS))),
        MeshMaterial3d(materials.add(StandardMaterial {
            base_color: COLOR_GOAL,
            ..default()
        })),
        Transform::from_translation(nav::to_world(GOAL, GOAL_MARKER_RADIUS)),
        scope.clone(),
    ));

    // Top-down camera (tiny Z nudge keeps `up = +Y` non-degenerate).
    commands.spawn((
        Camera3d::default(),
        Transform::from_xyz(0.0, CAM_HEIGHT, CAM_Z_NUDGE).looking_at(Vec3::ZERO, Vec3::Y),
        scope.clone(),
    ));

    hud::spawn_controls_overlay(
        &mut commands,
        state,
        &[
            "Auto: agent path-finds start -> goal",
            "A wall drops on its path -> it re-routes",
            "Esc — back to menu",
        ],
    );
    hud::spawn_fps_counter(&mut commands, state);

    commands.insert_resource(NavWorld {
        scenario,
        waypoints,
        leg: 0,
        drop_timer: Timer::from_seconds(DYNAMIC_DELAY_SECS, TimerMode::Once),
        dynamic_dropped: false,
        repaths: 0,
    });
}

/// Spawns a box visualizing a [`BlockedAabb`]: centred on the AABB, sized to it,
/// standing [`OBSTACLE_HEIGHT`] tall on the ground.
fn spawn_obstacle_box(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    materials: &mut Assets<StandardMaterial>,
    aabb: BlockedAabb,
    color: Color,
    scope: DespawnOnExit<AppState>,
) -> Entity {
    let size = aabb.max - aabb.min;
    let center = (aabb.min + aabb.max) * 0.5;
    commands
        .spawn((
            Mesh3d(meshes.add(Cuboid::new(size.x, OBSTACLE_HEIGHT, size.y))),
            MeshMaterial3d(materials.add(StandardMaterial {
                base_color: color,
                ..default()
            })),
            Transform::from_translation(nav::to_world(center, OBSTACLE_HEIGHT * 0.5)),
            scope,
        ))
        .id()
}

/// After the delay, drop the dynamic obstacle: add it to the scenario, spawn its
/// box, and **re-bake + re-query** the path from the agent's *current* position.
fn drop_dynamic_obstacle(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    time: Res<Time>,
    mut world: ResMut<NavWorld>,
    agent: Query<&Transform, With<Agent>>,
) {
    if world.dynamic_dropped {
        return;
    }
    world.drop_timer.tick(time.delta());
    if !world.drop_timer.is_finished() {
        return;
    }

    let dynamic = block(DYNAMIC_CENTER, BLOCK_HALF);
    world.scenario.dynamic = Some(dynamic);
    world.dynamic_dropped = true;

    spawn_obstacle_box(
        &mut commands,
        &mut meshes,
        &mut materials,
        dynamic,
        COLOR_DYNAMIC,
        DespawnOnExit(AppState::S14NavmeshPathfind),
    );

    // Re-path from where the agent actually is right now. With the shipped
    // timing (start far from DYNAMIC_CENTER, ~10 units of travel before the
    // drop) the agent is nowhere near the new wall, so `from` is never inside
    // the fresh AABB and the re-query always succeeds.
    let Ok(tf) = agent.single() else {
        return;
    };
    let from = Vec2::new(tf.translation.x, tf.translation.z);
    if let Some(new_route) = world.scenario.route(from, GOAL) {
        world.waypoints = new_route;
        world.leg = 0;
        world.repaths += 1;
        info!(
            "s14 nav: dynamic obstacle dropped -> re-path #{} from {:?} ({} waypoints)",
            world.repaths,
            from,
            world.waypoints.len(),
        );
    }
    // If the re-route is somehow None (it should not be — the field stays open),
    // keep the old waypoints so the agent at least continues toward the goal.
}

/// Walk the agent along the current waypoint polyline.
fn move_agent(time: Res<Time>, mut world: ResMut<NavWorld>, mut agent: Query<&mut Transform, With<Agent>>) {
    let Ok(mut tf) = agent.single_mut() else {
        return;
    };
    let pos = Vec2::new(tf.translation.x, tf.translation.z);
    let (new_pos, new_leg) = advance(pos, &world.waypoints, world.leg, AGENT_SPEED, time.delta_secs());
    world.leg = new_leg;
    let lifted = nav::to_world(new_pos, AGENT_RADIUS + AGENT_HALF_HEIGHT);
    tf.translation = lifted;
}

/// Gizmo navmesh debug: outer boundary, every active obstacle, and the agent's
/// current path. Visualization only — never runs under the headless tests.
fn draw_nav(mut gizmos: Gizmos, world: Res<NavWorld>) {
    nav::draw_polygon(&mut gizmos, &world.scenario.outer, GIZMO_Y, COLOR_BOUNDARY);
    for (i, obstacle) in world.scenario.obstacles().iter().enumerate() {
        let color = if i < world.scenario.static_blocked.len() {
            COLOR_STATIC
        } else {
            COLOR_DYNAMIC
        };
        nav::draw_polygon(&mut gizmos, &obstacle.polygon(), GIZMO_Y, color);
    }
    nav::draw_path(&mut gizmos, &world.waypoints, GIZMO_Y, COLOR_PATH);
}

// ============================================================================
// Headless tests (MinimalPlugins-free: the pure core needs no App at all)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// Goal-reach threshold (world units) for the simulated agent.
    const REACH_THRESHOLD: f32 = 0.05;
    /// Samples per polyline segment for the strict-interior intrusion check —
    /// matches the foundation's segment-sampling (waypoint-only would miss a
    /// corner-cutting chord).
    const SAMPLES_PER_SEGMENT: usize = 32;

    /// `true` if any point sampled along the polyline lies strictly inside the
    /// AABB. Segment-sampled, not waypoint-only.
    fn polyline_intrudes(poly: &[Vec2], aabb: &BlockedAabb) -> bool {
        for seg in poly.windows(2) {
            for k in 0..=SAMPLES_PER_SEGMENT {
                let t = k as f32 / SAMPLES_PER_SEGMENT as f32;
                if aabb.contains_strict(seg[0].lerp(seg[1], t)) {
                    return true;
                }
            }
        }
        false
    }

    /// Total length of a polyline.
    fn poly_length(poly: &[Vec2]) -> f32 {
        poly.windows(2).map(|s| s[0].distance(s[1])).sum()
    }

    /// The point at arc-length fraction `f` (0..=1) along the polyline. Used to
    /// drop a dynamic obstacle *guaranteed* to sit on a given route, with no
    /// assumption about which way Polyanya chose to bend.
    fn point_at_fraction(poly: &[Vec2], f: f32) -> Vec2 {
        let total = poly_length(poly);
        let target = total * f.clamp(0.0, 1.0);
        let mut acc = 0.0;
        for seg in poly.windows(2) {
            let d = seg[0].distance(seg[1]);
            if acc + d >= target {
                let t = if d > 0.0 { (target - acc) / d } else { 0.0 };
                return seg[0].lerp(seg[1], t);
            }
            acc += d;
        }
        *poly.last().expect("non-empty polyline")
    }

    /// Drive the agent along a fixed waypoint list to the end. Returns the final
    /// position (panics via the iteration cap if it never arrives — a non-vacuous
    /// "reached" guarantee).
    fn run_to_end(start: Vec2, waypoints: &[Vec2]) -> Vec2 {
        let dt = 1.0 / 60.0;
        let mut pos = start;
        let mut leg = 0;
        for _ in 0..100_000 {
            (pos, leg) = advance(pos, waypoints, leg, AGENT_SPEED, dt);
            if leg >= waypoints.len() {
                return pos;
            }
        }
        panic!("agent failed to reach the goal within the iteration cap");
    }

    /// The initial route exists, reaches the goal, avoids the static obstacle,
    /// and a simulated agent actually walks it to the goal.
    #[test]
    fn initial_route_reaches_goal_and_avoids_static() {
        let scenario = NavScenario::sample();
        let route = scenario.route(START, GOAL).expect("initial route must exist");
        assert!(route.len() >= 2, "route must have at least start+goal, got {route:?}");

        // Ends at the goal.
        let last = *route.last().unwrap();
        assert!(last.distance(GOAL) < 1e-3, "route should end at the goal, ended at {last:?}");

        // Avoids the static block (segment-sampled).
        let static_block = scenario.static_blocked[0];
        assert!(
            !polyline_intrudes(&route, &static_block),
            "initial route intrudes into the static obstacle {static_block:?}"
        );

        // A simulated agent walks the whole route to the goal.
        let final_pos = run_to_end(START, &route);
        assert!(
            final_pos.distance(GOAL) < REACH_THRESHOLD,
            "agent should reach the goal, stopped at {final_pos:?}"
        );
    }

    /// Dropping a dynamic obstacle *onto the initial route* forces a different
    /// path that still reaches the goal and avoids BOTH obstacles. Guards against
    /// a vacuous pass by first asserting the old route DID cross the new block
    /// (so the re-path was actually necessary).
    #[test]
    fn dynamic_obstacle_forces_avoiding_repath() {
        let mut scenario = NavScenario::sample();
        let route1 = scenario.route(START, GOAL).expect("initial route must exist");

        // Drop a block centred on the midpoint of route1 — guaranteed on-route,
        // no assumption about routing direction.
        let mid = point_at_fraction(&route1, 0.5);
        let dynamic = block(mid, BLOCK_HALF);

        // Sanity: the OLD route really does cross the new block (else the test
        // would pass vacuously — re-path not actually needed).
        assert!(
            polyline_intrudes(&route1, &dynamic),
            "the dropped block {dynamic:?} should sit on the old route (test would be vacuous otherwise)"
        );

        scenario.dynamic = Some(dynamic);
        let route2 = scenario
            .route(START, GOAL)
            .expect("a re-route must exist after the obstacle drops (field stays open)");
        assert!(route2.len() >= 2, "re-route must be non-empty, got {route2:?}");

        // Reaches the goal.
        let last = *route2.last().unwrap();
        assert!(last.distance(GOAL) < 1e-3, "re-route should end at the goal, ended at {last:?}");

        // Avoids BOTH the static block and the freshly dropped dynamic block.
        let static_block = scenario.static_blocked[0];
        assert!(
            !polyline_intrudes(&route2, &static_block),
            "re-route intrudes into the static obstacle {static_block:?}"
        );
        assert!(
            !polyline_intrudes(&route2, &dynamic),
            "re-route intrudes into the dynamic obstacle {dynamic:?} — it failed to avoid the new wall"
        );

        // The re-route genuinely differs: route1 crossed the block (asserted
        // above) while route2 does not, so they cannot be the same polyline.
        // Length-wise, adding an obstacle to an already-optimal path can only
        // keep or increase the optimum — never shorten it (monotonicity).
        assert!(
            poly_length(&route2) >= poly_length(&route1) - 1e-3,
            "re-route ({}) must not be shorter than the unconstrained original ({})",
            poly_length(&route2),
            poly_length(&route1),
        );

        // And a simulated agent still reaches the goal on the new route.
        let final_pos = run_to_end(START, &route2);
        assert!(
            final_pos.distance(GOAL) < REACH_THRESHOLD,
            "agent should reach the goal on the re-route, stopped at {final_pos:?}"
        );
    }

    /// The sample's hardcoded STATIC+DYNAMIC scenario (not a synthetic one) also
    /// re-routes correctly: with both blocks active the path reaches the goal and
    /// avoids both. Proves the constants the visual sample ships actually work.
    #[test]
    fn sample_scenario_repaths_around_both_blocks() {
        let mut scenario = NavScenario::sample();
        let dynamic = block(DYNAMIC_CENTER, BLOCK_HALF);

        // The shipped dynamic block must actually sit on the static-only route,
        // otherwise dropping it would be a visual no-op (non-vacuous guard on the
        // sample's hardcoded constants, not a synthetic on-route block).
        let static_only = scenario.route(START, GOAL).expect("static-only route must exist");
        assert!(
            polyline_intrudes(&static_only, &dynamic),
            "DYNAMIC_CENTER block {dynamic:?} should lie on the static-only route so the drop forces a real re-route"
        );

        scenario.dynamic = Some(dynamic);
        let route = scenario
            .route(START, GOAL)
            .expect("route must exist with both sample blocks active");

        for obstacle in scenario.obstacles() {
            assert!(
                !polyline_intrudes(&route, &obstacle),
                "sample-scenario route intrudes into obstacle {obstacle:?}"
            );
        }
        assert!(route.last().unwrap().distance(GOAL) < 1e-3, "sample route should end at the goal");
        assert!(run_to_end(START, &route).distance(GOAL) < REACH_THRESHOLD, "agent reaches goal on sample route");
    }

    /// Re-baking + re-querying from identical inputs is run-to-run bit-stable:
    /// the dynamic re-path is deterministic given fixed obstacle geometry. (The
    /// design's "navmesh drift" is cross-impl/platform, not run-to-run — this
    /// pins that finding so a future regression would surface.)
    #[test]
    fn rebake_is_deterministic() {
        let mut scenario = NavScenario::sample();
        scenario.dynamic = Some(block(DYNAMIC_CENTER, BLOCK_HALF));

        let a = scenario.route(START, GOAL).expect("route a");
        let b = scenario.route(START, GOAL).expect("route b");

        assert_eq!(a.len(), b.len(), "re-baked route waypoint counts must match");
        assert!(
            (poly_length(&a) - poly_length(&b)).abs() < 1e-6,
            "re-baked route lengths must match: {} vs {}",
            poly_length(&a),
            poly_length(&b)
        );
        for (pa, pb) in a.iter().zip(b.iter()) {
            assert!(pa.distance(*pb) < 1e-6, "re-baked waypoints must match: {pa:?} vs {pb:?}");
        }
    }

    /// An unreachable goal (outside the field) yields no route — guards the
    /// documented `None` path so a future vleue bump returning a clamped/garbage
    /// path would be caught (mirrors the foundation's negative test).
    #[test]
    fn unreachable_goal_has_no_route() {
        let scenario = NavScenario::sample();
        let outside = Vec2::new(FIELD_HALF * 10.0, FIELD_HALF * 10.0);
        assert!(
            scenario.route(START, outside).is_none(),
            "a goal outside the field should be unreachable"
        );
    }

    /// `advance` consumes its full budget across multiple short legs in one tick
    /// (so a re-path with many close corners is walked smoothly, not one-per-tick).
    #[test]
    fn advance_crosses_multiple_legs_in_one_tick() {
        // Three waypoints 1 unit apart; a 2.5-unit budget should clear two of them.
        let waypoints = [Vec2::new(1.0, 0.0), Vec2::new(2.0, 0.0), Vec2::new(3.0, 0.0)];
        let (pos, leg) = advance(Vec2::ZERO, &waypoints, 0, 2.5, 1.0);
        assert_eq!(leg, 2, "2.5 units should reach past the first two waypoints");
        assert!((pos.x - 2.5).abs() < 1e-5, "expected x=2.5, got {}", pos.x);
    }
}
