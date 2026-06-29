// Pure, render-independent re-path scenario for sample 14 (navmesh-pathfind).
// Builds on the Ch4 navmesh foundation (src/ai/navmesh): it generates a navmesh,
// queries an A->B path, then DROPS a dynamic obstacle onto the agent's initial
// corridor — re-baking the navmesh and re-querying so the new path routes around
// BOTH the original pillar and the newly-added block.
//
// No three.js / DOM imports: the same logic drives the GPU visualization
// (index.ts mount) and the headless proof (pathfind.test.ts). Native (WASM)
// navmesh memory is owned here and freed by `destroy()`.

import {
  type AabbXZ,
  type ObstacleCourse,
  type PathResult,
  type TriMesh,
  type Vec3,
  Navmesh,
  boxFootprintXZ,
  boxTriMesh,
  buildObstacleCourse,
  generateNavmesh,
  mergeTriMeshes,
} from "../../ai/navmesh";

// Dynamic obstacle that appears mid-traversal. Centered on the +X/-Z corridor
// the base path uses (the base route corners near (2.6, -2.8)); its footprint
// x[1,5] z[-5,-1] contains that corner, so dropping it genuinely invalidates the
// initial path and forces a re-route to the opposite (-X/+Z) corner.
const DYNAMIC_OBSTACLE_HALF: Vec3 = { x: 2, y: 1, z: 2 };
const DYNAMIC_OBSTACLE_CENTER: Vec3 = {
  x: 3,
  y: DYNAMIC_OBSTACLE_HALF.y,
  z: -3,
};

/** Geometry + XZ footprint of the dynamic obstacle (exported for visualization). */
export const dynamicObstacleSpec: { center: Vec3; half: Vec3 } = {
  center: DYNAMIC_OBSTACLE_CENTER,
  half: DYNAMIC_OBSTACLE_HALF,
};

/** Which obstacles are currently baked into the active navmesh. */
export type RepathPhase = "initial" | "blocked";

function bakeOrThrow(mesh: TriMesh): Navmesh {
  const result = generateNavmesh(mesh);
  if (!result.success) {
    throw new Error(`navmesh generation failed: ${result.error}`);
  }
  return result.navmesh;
}

/**
 * Stateful A->B re-path scenario. `initNavmesh()` MUST have resolved before
 * {@link PathfindScenario.create}. The scenario owns exactly one live
 * {@link Navmesh} at a time; {@link dropObstacle} re-bakes (replacing it) and
 * {@link destroy} frees the last one.
 */
export class PathfindScenario {
  /** Base scene (ground + central pillar) + start/goal. */
  readonly course: ObstacleCourse;
  /** XZ footprint of the dynamic obstacle (independent of bake phase). */
  readonly dynamicObstacle: AabbXZ;

  private active: Navmesh;
  private _phase: RepathPhase = "initial";

  private constructor(course: ObstacleCourse, navmesh: Navmesh) {
    this.course = course;
    this.active = navmesh;
    this.dynamicObstacle = boxFootprintXZ(
      DYNAMIC_OBSTACLE_CENTER,
      DYNAMIC_OBSTACLE_HALF,
    );
  }

  /** Build the base navmesh and return a fresh scenario in the `initial` phase. */
  static create(): PathfindScenario {
    const course = buildObstacleCourse();
    return new PathfindScenario(course, bakeOrThrow(course.mesh));
  }

  /** Which obstacles are baked into the current navmesh. */
  get phase(): RepathPhase {
    return this._phase;
  }

  /** The currently-active navmesh (changes identity after {@link dropObstacle}). */
  get navmesh(): Navmesh {
    return this.active;
  }

  /** Snap an arbitrary world point onto the active navmesh, or null if off-mesh. */
  closestPoint(point: Vec3): Vec3 | null {
    return this.active.closestPoint(point);
  }

  /** Query a path on the active navmesh from `start` (defaults to the scene start). */
  findPath(start: Vec3 = this.course.start, goal: Vec3 = this.course.goal): PathResult {
    return this.active.findPath(start, goal);
  }

  /**
   * Drop the dynamic obstacle: merge its geometry into the scene, re-bake the
   * navmesh (replacing + freeing the old one) and advance to the `blocked`
   * phase. Idempotent — a second call is a no-op. The caller re-queries via
   * {@link findPath} afterwards (typically from the agent's current position).
   */
  dropObstacle(): void {
    if (this._phase === "blocked") return;
    const block = boxTriMesh(DYNAMIC_OBSTACLE_CENTER, DYNAMIC_OBSTACLE_HALF);
    const merged = mergeTriMeshes([this.course.mesh, block]);
    const next = bakeOrThrow(merged);
    this.active.destroy();
    this.active = next;
    this._phase = "blocked";
  }

  /** Free the active navmesh's native (WASM) memory. Call exactly once. */
  destroy(): void {
    this.active.destroy();
  }
}
