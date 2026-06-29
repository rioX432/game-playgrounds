// Render-independent core for the navmesh-pathfind sample (Ch4 #198).
//
// This module holds everything that is NOT rendering: the numeric scenario
// (ground + a dynamic blocker), and a minimal path-follow stepper. Navmesh
// generation and A->B queries are delegated to the shared Ch4 foundation
// (`src/ai/navmesh.ts`) so this sample reuses the proven Recast/Detour wrapper
// rather than reinventing it. Keeping this core free of Babylon mesh/camera types
// is what lets the headless vitest proof (`pathfind.test.ts`) exercise the exact
// same scenario the visualization renders, under NullEngine with no DOM/GPU.

import type { NavBox, NavSceneSpec, Vec3 } from "../../ai/navmesh";

// --- Scenario geometry (a 20x20 ground; A and B on opposite sides in X). --------

/** Square ground the agent walks on; X and Z each span [-10, +10]. */
export const GROUND = { width: 20, depth: 20 } as const;

/** Path start (A) — left side. */
export const START: Vec3 = { x: -8, y: 0, z: 0 };
/** Path goal (B) — right side. */
export const GOAL: Vec3 = { x: 8, y: 0, z: 0 };

/**
 * The dynamic obstacle: a wall at X=0 that reaches the -Z edge and stops short of
 * the +Z edge, leaving a single gap to thread. Mirrors the foundation's proven
 * "wall-with-a-gap, not a free-standing box" geometry (a box the path can pass on
 * either side gets a corner clipped by Detour's straight string-pull; a wall that
 * touches an edge forces the detour through exactly one opening, so straight
 * segments never cross the footprint — see `src/ai/README.md`).
 *
 * Spans Z in [-10, +6]; the walkable gap is Z in (+6, +10).
 */
export const DYNAMIC_WALL: NavBox = {
  center: { x: 0, y: 2, z: -2 },
  size: { x: 2, y: 4, z: 16 },
};

/** Base world: open ground, so the A->B path is essentially the straight line. */
export const BASE_SPEC: NavSceneSpec = {
  ground: GROUND,
  blockers: [],
};

/** World after the obstacle drops: the wall forces a detour through the gap. */
export const OBSTACLE_SPEC: NavSceneSpec = {
  ground: GROUND,
  blockers: [DYNAMIC_WALL],
};

// --- Minimal path-follow steering (deterministic; the "minimum to follow"). ------

/** Agent travel speed along the path, world units / second. */
export const AGENT_SPEED = 5;
/** Distance within which the agent snaps to a waypoint and targets the next. */
export const WAYPOINT_SNAP = 0.2;

/** Immutable follow progress along a fixed path. */
export interface FollowState {
  /** Current agent position (xz-plane; y tracks the path's y). */
  readonly pos: Vec3;
  /** Index of the waypoint currently being steered toward. */
  readonly index: number;
  /** True once the final waypoint has been reached. */
  readonly done: boolean;
}

/** Seed a {@link FollowState} at the path's first point, aiming at the second. */
export function createFollowState(path: Vec3[]): FollowState {
  if (path.length === 0) {
    return { pos: { x: 0, y: 0, z: 0 }, index: 0, done: true };
  }
  return { pos: { ...path[0] }, index: 1, done: path.length <= 1 };
}

/**
 * Advance the agent toward its current target waypoint by `speed * dt` on the
 * xz-plane, snapping to and consuming waypoints within {@link WAYPOINT_SNAP}.
 * Pure: returns a new state, never mutates the input. A frame's travel budget can
 * cross several short waypoints, so the agent never stalls on dense corridors.
 */
export function stepFollow(
  state: FollowState,
  path: Vec3[],
  speed: number,
  dt: number,
): FollowState {
  if (state.done || state.index >= path.length) {
    return { pos: state.pos, index: state.index, done: true };
  }
  let index = state.index;
  let pos: Vec3 = { ...state.pos };
  let budget = Math.max(0, speed * dt);

  while (index < path.length) {
    const target = path[index];
    const dx = target.x - pos.x;
    const dz = target.z - pos.z;
    const dist = Math.hypot(dx, dz);

    if (dist <= WAYPOINT_SNAP) {
      // Close enough: snap onto the waypoint and steer at the next one.
      pos = { x: target.x, y: target.y, z: target.z };
      index += 1;
      continue;
    }
    if (budget <= 0) break;

    const stepDist = Math.min(budget, dist);
    pos = {
      x: pos.x + (dx / dist) * stepDist,
      y: target.y,
      z: pos.z + (dz / dist) * stepDist,
    };
    budget -= stepDist;
    if (stepDist >= dist) index += 1; // reached this waypoint exactly
  }

  return { pos, index, done: index >= path.length };
}
