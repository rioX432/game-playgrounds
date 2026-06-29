// Headless navmesh proof (Ch4 foundation). Runs under vitest's `node` environment
// with no DOM/GPU: `buildHeadlessNav` spins up a private NullEngine, Babylon's
// `RecastJSPlugin` builds the navmesh, and `computePath` answers queries.
//
// Per the Ch4 design, navmesh generation is sensitive to WASM init / Recast
// parameters / float order, so these asserts test ROBUST PROPERTIES — goal reached,
// no intrusion into the blocked AABB, a detour actually happened, determinism of a
// repeated query — and deliberately NOT an exact path point-sequence.

import { describe, expect, it } from "vitest";
import {
  buildHeadlessNav,
  isInsideFootprintXZ,
  pathLength,
  type NavBox,
  type NavSceneSpec,
  type Vec3,
} from "./navmesh";

// A 20×20 ground split by a wall that spans from the left edge to x≈+4, leaving a
// gap on the right. Start and goal sit on the same (left) side in z, so the only
// route is a detour through the gap — a deterministic obstacle-avoidance scenario.
const WALL: NavBox = { center: { x: -3, y: 2, z: 0 }, size: { x: 14, y: 4, z: 2 } };
const WALLED_SCENE: NavSceneSpec = {
  ground: { width: 20, depth: 20 },
  blockers: [WALL],
};
const OPEN_SCENE: NavSceneSpec = {
  ground: { width: 20, depth: 20 },
  blockers: [],
};
const START: Vec3 = { x: -8, y: 0, z: -8 };
const GOAL: Vec3 = { x: -8, y: 0, z: 8 };

// Goal-reached tolerance and intrusion sampling step, in world units / [0,1].
const REACH_THRESHOLD = 1.0;
const SEGMENT_SAMPLE_STEP = 0.01;
// How close the open-ground path may stay to the straight line, world units.
const OPEN_PATH_SLACK = 1.0;
// Minimum extra length the walled (detoured) path must add over the open one, world units.
const MIN_DETOUR_EXTRA = 4.0;

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

describe("buildHeadlessNav", () => {
  it("computes a path that reaches the goal around a wall", async () => {
    const nav = await buildHeadlessNav(WALLED_SCENE);
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

  it("routes around the wall without intruding its blocked AABB", async () => {
    const nav = await buildHeadlessNav(WALLED_SCENE);
    try {
      const start = nav.closestPoint(START);
      const goal = nav.closestPoint(GOAL);
      const path = nav.computePath(start, goal);

      // Guard against a vacuous pass: an empty path would satisfy both checks below.
      expect(path.length).toBeGreaterThan(1);
      // No waypoint sits inside the wall footprint...
      for (const p of path) {
        expect(isInsideFootprintXZ(WALL, p, 0)).toBe(false);
      }
      // ...and neither does any point along the straight segments between them.
      expect(pathIntrudes(path, WALL)).toBe(false);
    } finally {
      nav.dispose();
    }
  });

  it("detours: the walled path is materially longer than the open one", async () => {
    const walled = await buildHeadlessNav(WALLED_SCENE);
    const open = await buildHeadlessNav(OPEN_SCENE);
    try {
      const start = walled.closestPoint(START);
      const goal = walled.closestPoint(GOAL);

      const walledPath = walled.computePath(start, goal);
      const openPath = open.computePath(start, goal);

      const directDistance = distXZ(start, goal);
      // The open path is essentially the straight line; the walled path bends.
      expect(pathLength(openPath)).toBeLessThan(directDistance + OPEN_PATH_SLACK);
      expect(walledPath.length).toBeGreaterThan(openPath.length);
      expect(pathLength(walledPath)).toBeGreaterThan(
        pathLength(openPath) + MIN_DETOUR_EXTRA,
      );
    } finally {
      walled.dispose();
      open.dispose();
    }
  });

  it("is deterministic for a repeated query on the same navmesh", async () => {
    const nav = await buildHeadlessNav(WALLED_SCENE);
    try {
      const start = nav.closestPoint(START);
      const goal = nav.closestPoint(GOAL);

      const a = nav.computePath(start, goal);
      const b = nav.computePath(start, goal);
      expect(a).toEqual(b);
    } finally {
      nav.dispose();
    }
  });

  it("returns an empty path when the goal is off the navmesh", async () => {
    const nav = await buildHeadlessNav(WALLED_SCENE);
    try {
      const start = nav.closestPoint(START);
      // Far outside the 20×20 ground — no reachable navmesh polygon there.
      const unreachable: Vec3 = { x: 1000, y: 0, z: 1000 };
      const path = nav.computePath(start, unreachable);
      expect(path.length).toBe(0);
    } finally {
      nav.dispose();
    }
  });
});
