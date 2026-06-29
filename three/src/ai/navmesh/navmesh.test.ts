// Headless proof for the Ch4 Three navmesh foundation. Runs in the `node`
// vitest environment with NO GPU and NO window — it establishes WASM init and
// then asserts ROBUST properties of a seed-free, deterministic scene:
//
//   1. WASM init resolves (and is idempotent).
//   2. A solo navmesh builds from primitive geometry.
//   3. An A->B query REACHES the goal (final XZ distance < threshold).
//   4. The path does NOT intrude the blocked obstacle footprint.
//
// It deliberately does NOT assert an exact path point sequence: that drifts with
// WASM init, Recast parameters and float rounding (see design-ch4 §3.1).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  boxTriMesh,
  generateNavmesh,
  initNavmesh,
  mergeTriMeshes,
  Navmesh,
  pathEndDistanceXZ,
  pathIntrudesAabbXZ,
} from "./index";
import { buildObstacleCourse } from "./scene";

// Goal-reached threshold: one obstacle-free path corner should land within this
// XZ distance of the goal. Generous vs. cs/ch (0.2 m) to stay robust to voxel
// quantization, strict enough that "did not arrive" still fails.
const GOAL_REACHED_DISTANCE = 0.5; // m

// The path is allowed to graze the obstacle border by up to the agent radius
// (walkableRadiusVx * cs = 1 * 0.2 m); intrusion is checked with that inset so
// a legitimate hug of the wall is not flagged, but cutting through is.
const OBSTACLE_INTRUSION_MARGIN = 0.2; // m

describe("navmesh WASM init", () => {
  it("resolves and is idempotent across repeated calls", async () => {
    await expect(initNavmesh()).resolves.toBeUndefined();
    await expect(initNavmesh()).resolves.toBeUndefined();
  });
});

describe("navmesh generation + A->B query (obstacle course)", () => {
  let course: ReturnType<typeof buildObstacleCourse>;
  let navmesh: Navmesh;

  beforeAll(async () => {
    await initNavmesh();
    course = buildObstacleCourse();
    const result = generateNavmesh(course.mesh);
    if (!result.success) {
      throw new Error(`navmesh generation failed: ${result.error}`);
    }
    navmesh = result.navmesh;
  });

  afterAll(() => {
    navmesh?.destroy();
  });

  it("reaches the goal corner within the threshold", () => {
    const path = navmesh.findPath(course.start, course.goal);
    expect(path.success).toBe(true);
    expect(path.points.length).toBeGreaterThan(0);
    expect(pathEndDistanceXZ(path.points, course.goal)).toBeLessThan(
      GOAL_REACHED_DISTANCE,
    );
  });

  it("routes AROUND the obstacle (no corner inside its footprint)", () => {
    const path = navmesh.findPath(course.start, course.goal);
    expect(
      pathIntrudesAabbXZ(path.points, course.obstacle, OBSTACLE_INTRUSION_MARGIN),
    ).toBe(false);
  });

  it("detours rather than going straight through the origin", () => {
    // The straight line start->goal crosses the origin (inside the obstacle), so
    // a valid path needs an intermediate corner — proving real avoidance, not a
    // trivial two-point line.
    const path = navmesh.findPath(course.start, course.goal);
    expect(path.points.length).toBeGreaterThanOrEqual(3);
  });

  it("snaps a point hovering above the floor onto the walkable surface", () => {
    // A valid XZ location lifted above the navmesh (within the query's vertical
    // search extent) should snap down to a near-y=0 point on the surface.
    const snapped = navmesh.closestPoint({ x: 3, y: 3, z: 7 });
    expect(snapped).not.toBeNull();
    expect(Math.abs(snapped!.y)).toBeLessThan(1);
  });
});

describe("navmesh generation failure handling", () => {
  it("returns a failure result for degenerate input instead of throwing", async () => {
    await initNavmesh();
    // A single zero-area triangle rasterizes to nothing -> no walkable polys.
    const degenerate = {
      positions: new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0]),
      indices: new Uint32Array([0, 1, 2]),
    };
    const result = generateNavmesh(degenerate);
    expect(result.success).toBe(false);
  });
});

describe("pure geometry helpers (no WASM)", () => {
  it("merges meshes by offsetting indices into their own vertices", () => {
    const a = boxTriMesh({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 });
    const b = boxTriMesh({ x: 5, y: 0, z: 0 }, { x: 1, y: 1, z: 1 });
    const merged = mergeTriMeshes([a, b]);
    expect(merged.positions.length).toBe(a.positions.length + b.positions.length);
    expect(merged.indices.length).toBe(a.indices.length + b.indices.length);
    // Second mesh's indices must point past the first mesh's vertices.
    const vertsInA = a.positions.length / 3;
    const maxIndex = merged.indices.reduce((m, v) => Math.max(m, v), 0);
    expect(maxIndex).toBeGreaterThanOrEqual(vertsInA);
  });
});
