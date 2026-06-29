// A fixed, deterministic test scene shared by the headless proof and (later) by
// the navmesh-pathfind / guard-ai samples. Geometry is pure data (primitives
// only, per the playground's "no bespoke art" rule), so the same scene drives
// both the GPU visualization and the no-GPU assertions.

import type { AabbXZ, TriMesh, Vec3 } from "./geometry";
import { boxFootprintXZ, boxTriMesh, mergeTriMeshes } from "./geometry";

// Ground slab: a 20x20 m walkable floor whose top face sits at y = 0. A solid
// slab (not a flat quad) is required for a non-degenerate heightfield.
const GROUND_HALF = 10; // m, half-width in X and Z
const GROUND_THICKNESS = 0.5; // m
const GROUND_TOP_Y = 0;

// A single blocking pillar in the middle. It is tall enough that its top is an
// isolated island and its footprint carves a hole the agent must route around.
const OBSTACLE_CENTER: Vec3 = { x: 0, y: 1.5, z: 0 };
const OBSTACLE_HALF: Vec3 = { x: 2.5, y: 1.5, z: 2.5 };

// Start and goal on opposite corners. The straight line between them passes
// through the origin (inside the obstacle), so any valid path MUST detour.
const START: Vec3 = { x: -8, y: 0, z: -8 };
const GOAL: Vec3 = { x: 8, y: 0, z: 8 };

/** Everything a consumer needs to build a navmesh and assert against it. */
export type ObstacleCourse = {
  /** Merged scene geometry (ground + obstacle) for navmesh generation. */
  mesh: TriMesh;
  /** XZ footprint of the blocking obstacle (a path must not intrude here). */
  obstacle: AabbXZ;
  /** Agent start position (on the ground). */
  start: Vec3;
  /** Agent goal position (opposite corner). */
  goal: Vec3;
};

/**
 * Build the canonical obstacle course: a ground slab plus one central blocking
 * pillar, with start/goal on opposite corners. Deterministic — no RNG, no time.
 */
export function buildObstacleCourse(): ObstacleCourse {
  const ground = boxTriMesh(
    { x: 0, y: GROUND_TOP_Y - GROUND_THICKNESS / 2, z: 0 },
    { x: GROUND_HALF, y: GROUND_THICKNESS / 2, z: GROUND_HALF },
  );
  const obstacle = boxTriMesh(OBSTACLE_CENTER, OBSTACLE_HALF);
  return {
    mesh: mergeTriMeshes([ground, obstacle]),
    obstacle: boxFootprintXZ(OBSTACLE_CENTER, OBSTACLE_HALF),
    start: { ...START },
    goal: { ...GOAL },
  };
}
