// Headless proof for navmesh-pathfind (Ch4 #198). Runs under vitest's `node`
// environment with no DOM/GPU: the shared foundation's `buildHeadlessNav` spins up
// a private NullEngine, Babylon's `RecastJSPlugin` builds the navmesh, and
// `computePath` answers A->B queries.
//
// Per the Ch4 design, navmesh generation is sensitive to WASM init / Recast
// parameters / float order, so these asserts test ROBUST PROPERTIES — goal
// reached, no intrusion into the dynamic obstacle's AABB, a real detour happened,
// determinism of a rebuilt-with-obstacle query — and deliberately NOT an exact
// path point-sequence. Every check is guarded against a vacuous empty-path pass.

import { describe, expect, it } from "vitest";
import {
  buildHeadlessNav,
  isInsideFootprintXZ,
  pathLength,
  type NavBox,
  type Vec3,
} from "../../ai/navmesh";
import {
  AGENT_SPEED,
  BASE_SPEC,
  createFollowState,
  DYNAMIC_WALL,
  GOAL,
  OBSTACLE_SPEC,
  START,
  stepFollow,
} from "./pathfind";

// Goal-reached tolerance (world units), segment sampling step, and the minimum
// extra length the detour must add over the open straight path (world units).
const REACH_THRESHOLD = 1.0;
const SEGMENT_SAMPLE_STEP = 0.01;
const MIN_DETOUR_EXTRA = 2.5;
// Fixed step the follow simulation integrates at, and a generous iteration cap so
// a stuck agent fails loudly instead of looping forever.
const FOLLOW_DT = 1 / 60;
const MAX_FOLLOW_STEPS = 2000;

const distXZ = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.z - b.z);

/** Densely sample every segment and report whether any point enters the box AABB. */
function pathIntrudes(path: Vec3[], box: NavBox): boolean {
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    for (let t = 0; t <= 1; t += SEGMENT_SAMPLE_STEP) {
      const p: Vec3 = {
        x: a.x + (b.x - a.x) * t,
        y: 0,
        z: a.z + (b.z - a.z) * t,
      };
      if (isInsideFootprintXZ(box, p, 0)) return true;
    }
  }
  return false;
}

describe("navmesh-pathfind core", () => {
  it("base path reaches the goal across open ground", async () => {
    const nav = await buildHeadlessNav(BASE_SPEC);
    try {
      const start = nav.closestPoint(START);
      const goal = nav.closestPoint(GOAL);
      const path = nav.computePath(start, goal);

      expect(path.length).toBeGreaterThan(1);
      expect(distXZ(path[path.length - 1], goal)).toBeLessThan(REACH_THRESHOLD);
    } finally {
      nav.dispose();
    }
  });

  it("dynamic obstacle forces a re-path that avoids it and still reaches the goal", async () => {
    const open = await buildHeadlessNav(BASE_SPEC);
    const blocked = await buildHeadlessNav(OBSTACLE_SPEC);
    try {
      const start = blocked.closestPoint(START);
      const goal = blocked.closestPoint(GOAL);

      const basePath = open.computePath(open.closestPoint(START), open.closestPoint(GOAL));
      const rePath = blocked.computePath(start, goal);

      // Non-vacuous: both queries must yield real paths.
      expect(basePath.length).toBeGreaterThan(1);
      expect(rePath.length).toBeGreaterThan(1);

      // Re-path still reaches the goal.
      expect(distXZ(rePath[rePath.length - 1], goal)).toBeLessThan(REACH_THRESHOLD);

      // Re-path avoids the dynamic obstacle: no waypoint and no straight segment
      // between waypoints enters the wall footprint.
      for (const p of rePath) {
        expect(isInsideFootprintXZ(DYNAMIC_WALL, p, 0)).toBe(false);
      }
      expect(pathIntrudes(rePath, DYNAMIC_WALL)).toBe(false);

      // A real detour happened: the re-path is materially longer than the open one.
      expect(pathLength(rePath)).toBeGreaterThan(
        pathLength(basePath) + MIN_DETOUR_EXTRA,
      );
    } finally {
      open.dispose();
      blocked.dispose();
    }
  });

  it("re-path is deterministic when the obstacle navmesh is rebuilt", async () => {
    // The dynamic obstacle is modeled by rebuilding the navmesh with the blocker
    // added (not a tile-cache mutation), so two independent rebuilds of the same
    // spec must produce identical paths — the sample's determinism guarantee.
    const a = await buildHeadlessNav(OBSTACLE_SPEC);
    const b = await buildHeadlessNav(OBSTACLE_SPEC);
    try {
      const pathA = a.computePath(a.closestPoint(START), a.closestPoint(GOAL));
      const pathB = b.computePath(b.closestPoint(START), b.closestPoint(GOAL));
      expect(pathA.length).toBeGreaterThan(1);
      expect(pathA).toEqual(pathB);
    } finally {
      a.dispose();
      b.dispose();
    }
  });

  it("an agent following the re-path converges on the goal", async () => {
    const nav = await buildHeadlessNav(OBSTACLE_SPEC);
    try {
      const goal = nav.closestPoint(GOAL);
      const path = nav.computePath(nav.closestPoint(START), goal);
      expect(path.length).toBeGreaterThan(1);

      let state = createFollowState(path);
      let steps = 0;
      while (!state.done && steps < MAX_FOLLOW_STEPS) {
        state = stepFollow(state, path, AGENT_SPEED, FOLLOW_DT);
        steps += 1;
      }

      expect(state.done).toBe(true);
      expect(distXZ(state.pos, goal)).toBeLessThan(REACH_THRESHOLD);
    } finally {
      nav.dispose();
    }
  });
});
