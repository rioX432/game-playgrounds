//! # Chapter 4 (NPC/AI) — navigation foundation
//!
//! Render-independent navmesh + path-query core shared by the Ch4 NPC-AI
//! samples (14 navmesh-pathfind, 16 guard-ai). Pure CPU, headless-testable —
//! exactly the "no-DOM, headless-testable purity" the design (§4) asks for.
//!
//! ## Two nav crates, two roles (Core Value #2 exception — see CLAUDE.md)
//!
//! * **`vleue_navigator` (Polyanya) — path QUERY.** Pure-CPU, synchronous,
//!   deterministic: build a navmesh from a 2-D outer boundary + obstacle
//!   polygons (constrained Delaunay triangulation) and query corner-to-corner
//!   paths. This is what the headless `cargo test` proof exercises.
//! * **`bevy_rerecast` (Recast) — navmesh BAKING** from 3-D `Mesh3d` scene
//!   geometry. Async/asset-based; wired here as [`add_nav_baking`] for the later
//!   visual samples. Generation is requested through the `NavmeshGenerator`
//!   system-param and completes over several frames (a `NavmeshReady` trigger).
//!
//! ### Honest finding (drives the headless-test design)
//! There is **no first-party bridge** between the two crates: rerecast bakes a
//! Recast `Navmesh` asset, vleue queries a Polyanya `NavMesh`, and neither
//! converts to the other in 0.4 / 0.15. So the deterministic proof goes through
//! vleue's own CDT navmesh-gen + query (pure CPU), while rerecast's async Recast
//! pipeline is proven by compile + plugin wiring. Asserting the exact path of an
//! async Recast bake in a unit test would be flaky (Codex pitfall #2: Polyanya
//! vs Detour / float drift) — so we assert robust properties only.
//!
//! ### Bevy 0.18.1 pin
//! rerecast 0.4 / vleue 0.15 are the newest releases and both target bevy
//! `^0.18`; no 0.19-compatible nav crate exists yet (checked crates.io
//! 2026-06-29). Revisit when vleue 0.16 / rerecast 0.5 land.

// Foundation API: most of this module is consumed by the Ch4 visual samples
// (14 navmesh-pathfind, 16 guard-ai) and the headless tests below, not by the
// menu app — so it reads as dead code in a plain (non-test) build. Same
// ahead-of-consumers pattern as `SampleMeta`'s as-yet-unrendered fields.
#![allow(dead_code)]

use bevy::prelude::*;
use vleue_navigator::{NavMesh, Triangulation};

// Re-export the query result type so samples/tests need only this module.
pub use vleue_navigator::Path;

/// An axis-aligned blocked rectangle — a hole punched into the navmesh.
///
/// Stored as min/max corners. Polyanya waypoints legitimately sit *on* an
/// obstacle's border (they hug the corners), so intrusion tests use the
/// strict-interior check [`BlockedAabb::contains_strict`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BlockedAabb {
    pub min: Vec2,
    pub max: Vec2,
}

impl BlockedAabb {
    /// New AABB from min/max corners (caller guarantees `min <= max`).
    pub const fn new(min: Vec2, max: Vec2) -> Self {
        Self { min, max }
    }

    /// The four corners as a closed polygon, clockwise so that — against a
    /// counter-clockwise outer boundary — the CDT treats it as a hole.
    pub fn polygon(&self) -> Vec<Vec2> {
        vec![
            Vec2::new(self.min.x, self.min.y),
            Vec2::new(self.min.x, self.max.y),
            Vec2::new(self.max.x, self.max.y),
            Vec2::new(self.max.x, self.min.y),
        ]
    }

    /// `true` only when `p` is *strictly* inside (open interior). Points on the
    /// border are not "inside" — Polyanya routes along the border.
    pub fn contains_strict(&self, p: Vec2) -> bool {
        p.x > self.min.x && p.x < self.max.x && p.y > self.min.y && p.y < self.max.y
    }
}

/// Build a flat (XZ-plane, 2-D `Vec2`) navmesh from a counter-clockwise outer
/// boundary with rectangular blocked regions as holes.
///
/// Pure CPU via Polyanya's constrained Delaunay triangulation — no Bevy `App`,
/// no GPU, fully deterministic for a fixed input.
pub fn build_flat_navmesh(outer: &[Vec2], blocked: &[BlockedAabb]) -> NavMesh {
    let mut triangulation = Triangulation::from_outer_edges(outer);
    triangulation.add_obstacles(blocked.iter().map(|b| b.polygon()));
    NavMesh::from_polyanya_mesh(triangulation.as_navmesh())
}

/// Query a path across a flat navmesh. `None` when `to` is unreachable from
/// `from`. The returned [`Path::path`] ends at `to`; [`Path::length`] is the
/// total travelled distance (>= straight-line distance when a detour is forced).
pub fn find_path(navmesh: &NavMesh, from: Vec2, to: Vec2) -> Option<Path> {
    navmesh.path(from, to)
}

// --- Recast baking wiring (bevy_rerecast) — for the later visual samples -----

/// Add the plugins that enable Recast navmesh **baking** from `Mesh3d` scene
/// geometry. The later Ch4 visual samples call this; the menu app does not (the
/// baking infra is unused until a sample needs it).
///
/// Generation flow (async): add these plugins, request a bake via the
/// `bevy_rerecast::prelude::NavmeshGenerator` system-param, then read the
/// finished `bevy_rerecast::prelude::Navmesh` asset once the `NavmeshReady`
/// trigger fires (several frames later).
pub fn add_nav_baking(app: &mut App) -> &mut App {
    use bevy_rerecast::prelude::NavmeshPlugins;
    use bevy_rerecast::Mesh3dBackendPlugin;
    app.add_plugins((NavmeshPlugins::default(), Mesh3dBackendPlugin::default()))
}

// --- Minimal navmesh-debug draw helpers (gizmos) — for later visual samples --

/// Lift a flat `Vec2` (XZ) navmesh point to a 3-D world point at height `y`.
#[inline]
pub fn to_world(p: Vec2, y: f32) -> Vec3 {
    Vec3::new(p.x, y, p.y)
}

/// Draw a path as connected line segments on the XZ plane at height `y`.
/// Minimal debug helper for the visual samples (the test core never needs it).
pub fn draw_path(gizmos: &mut Gizmos, path: &[Vec2], y: f32, color: Color) {
    for seg in path.windows(2) {
        gizmos.line(to_world(seg[0], y), to_world(seg[1], y), color);
    }
}

/// Draw a closed polygon outline (boundary or obstacle) on the XZ plane.
pub fn draw_polygon(gizmos: &mut Gizmos, polygon: &[Vec2], y: f32, color: Color) {
    let n = polygon.len();
    if n < 2 {
        return;
    }
    for i in 0..n {
        let a = to_world(polygon[i], y);
        let b = to_world(polygon[(i + 1) % n], y);
        gizmos.line(a, b, color);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A 10x10 flat field with one 2x2 blocked square at its centre.
    fn field() -> (Vec<Vec2>, BlockedAabb) {
        let outer = vec![
            Vec2::new(0.0, 0.0),
            Vec2::new(10.0, 0.0),
            Vec2::new(10.0, 10.0),
            Vec2::new(0.0, 10.0),
        ];
        let blocked = BlockedAabb::new(Vec2::new(4.0, 4.0), Vec2::new(6.0, 6.0));
        (outer, blocked)
    }

    /// Corner-to-corner across a centre obstacle: path reaches the goal and
    /// never intrudes into the blocked AABB (the design's two robust asserts).
    #[test]
    fn path_reaches_goal_and_avoids_blocked_aabb() {
        let (outer, blocked) = field();
        let navmesh = build_flat_navmesh(&outer, &[blocked]);

        let from = Vec2::new(1.0, 1.0);
        let to = Vec2::new(9.0, 9.0);
        let path = find_path(&navmesh, from, to).expect("a path exists corner-to-corner");

        // (i) goal reached: the path ends at the goal.
        let last = *path.path.last().expect("non-empty path");
        assert!(
            last.distance(to) < 1e-3,
            "path should end at the goal, ended at {last:?}"
        );

        // (ii) the path POLYLINE never enters the blocked interior. Checking
        // waypoints alone is too weak — Polyanya waypoints sit ON the border
        // (strict-excluded), so a corner-cutting regression (two opposite-corner
        // waypoints whose connecting segment crosses the centre) would pass
        // vacuously. Sample along each segment instead.
        const SAMPLES_PER_SEGMENT: usize = 32;
        for seg in path.path.windows(2) {
            for k in 0..=SAMPLES_PER_SEGMENT {
                let t = k as f32 / SAMPLES_PER_SEGMENT as f32;
                let p = seg[0].lerp(seg[1], t);
                assert!(
                    !blocked.contains_strict(p),
                    "path segment {:?}->{:?} intrudes into blocked AABB {blocked:?} at t={t}",
                    seg[0],
                    seg[1]
                );
            }
        }
    }

    /// A goal off the navmesh (beyond the outer boundary) is unreachable —
    /// pins the documented `None` return of `find_path` so a future vleue bump
    /// that started returning a clamped/garbage path would be caught.
    #[test]
    fn unreachable_goal_returns_none() {
        let (outer, blocked) = field();
        let navmesh = build_flat_navmesh(&outer, &[blocked]);

        let from = Vec2::new(1.0, 1.0);
        let outside = Vec2::new(100.0, 100.0); // far beyond the 10x10 field
        assert!(
            find_path(&navmesh, from, outside).is_none(),
            "a goal outside the navmesh should be unreachable (got a path)"
        );
    }

    /// Routing around the obstacle is strictly longer than the straight line —
    /// proves the hole actually deflects the path (not a straight shot through).
    #[test]
    fn detour_is_longer_than_straight_line() {
        let (outer, blocked) = field();
        let navmesh = build_flat_navmesh(&outer, &[blocked]);

        let from = Vec2::new(1.0, 1.0);
        let to = Vec2::new(9.0, 9.0);
        let path = find_path(&navmesh, from, to).expect("a path exists");

        let straight = from.distance(to);
        assert!(
            path.length > straight + 1e-3,
            "detour length {} should exceed straight-line {}",
            path.length,
            straight
        );
    }

    /// Unobstructed query on an empty field returns a (near) straight path —
    /// sanity that the navmesh isn't spuriously blocking open space.
    #[test]
    fn open_field_path_is_near_straight() {
        let outer = vec![
            Vec2::new(0.0, 0.0),
            Vec2::new(10.0, 0.0),
            Vec2::new(10.0, 10.0),
            Vec2::new(0.0, 10.0),
        ];
        let navmesh = build_flat_navmesh(&outer, &[]);

        let from = Vec2::new(1.0, 1.0);
        let to = Vec2::new(9.0, 9.0);
        let path = find_path(&navmesh, from, to).expect("a path exists on open field");

        assert!((path.length - from.distance(to)).abs() < 1e-2);
    }

    /// bevy_rerecast Recast-baking plugins build under a headless `App`
    /// (MinimalPlugins + AssetPlugin) without panicking — proves the crate
    /// integrates on Bevy 0.18.1, independent of the vleue query path.
    #[test]
    fn rerecast_baking_plugins_build_headless() {
        let mut app = App::new();
        app.add_plugins(MinimalPlugins)
            .add_plugins(AssetPlugin::default());
        add_nav_baking(&mut app);
        app.update();
    }
}
