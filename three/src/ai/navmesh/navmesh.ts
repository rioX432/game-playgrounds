// Render-independent wrapper around recast-navigation-js (Detour). This is the
// "raw / direct library" integration the Ch4 design assigns to Three: we own
// WASM init, navmesh generation, and path queries ourselves, and normalize the
// results into small plain DTOs so a Sample (or a headless test) can use them
// without touching three.js. Visualization lives in `debugView.ts`.

import { init, NavMesh, NavMeshQuery } from "recast-navigation";
import { generateSoloNavMesh } from "recast-navigation/generators";
import type { AabbXZ, TriMesh, Vec3 } from "./geometry";
import { pointInAabbXZ } from "./geometry";

/**
 * Solo-navmesh build parameters. `cs`/`ch` are world units; the `*Vx` values are
 * voxel counts (Recast's native unit) — a common foot-gun, so they are named
 * explicitly here rather than mirroring the library's bare field names.
 */
export type NavmeshConfig = {
  /** XZ cell size, world units. Smaller = finer navmesh, slower build. */
  cs: number;
  /** Y cell height, world units. */
  ch: number;
  /** Agent radius the walkable area is eroded by, in voxels. */
  walkableRadiusVx: number;
  /** Minimum floor-to-ceiling clearance to stay walkable, in voxels. */
  walkableHeightVx: number;
  /** Maximum ledge height still treated as traversable, in voxels. */
  walkableClimbVx: number;
};

/** Defaults tuned for the ~20 m primitive scenes these samples use. */
export const DEFAULT_NAVMESH_CONFIG: NavmeshConfig = {
  cs: 0.2,
  ch: 0.2,
  walkableRadiusVx: 1,
  walkableHeightVx: 2,
  walkableClimbVx: 1,
};

/** Default search box half-extents when snapping a query point onto the mesh. */
const DEFAULT_HALF_EXTENTS: Vec3 = { x: 2, y: 4, z: 2 };

// recast-navigation's WASM module is a process-wide singleton. Cache the init
// promise so repeated callers (samples, every test case) share one load; on
// failure, clear the cache so a later call can retry instead of resolving a
// permanently-rejected promise.
let initPromise: Promise<void> | null = null;

/**
 * Initialize the recast-navigation WASM runtime. Idempotent and safe to await
 * from many places. MUST be awaited before {@link generateNavmesh}. Rejects with
 * a wrapped error if the WASM module fails to load (e.g. missing binary).
 */
export function initNavmesh(): Promise<void> {
  if (!initPromise) {
    initPromise = init()
      .then(() => undefined)
      .catch((err: unknown) => {
        initPromise = null; // allow a retry
        throw new Error(
          `recast-navigation WASM init failed: ${stringifyError(err)}`,
        );
      });
  }
  return initPromise;
}

/** Result of a navmesh build: either a usable {@link Navmesh} or an error. */
export type NavmeshResult =
  | { success: true; navmesh: Navmesh }
  | { success: false; error: string };

/**
 * Build a solo navmesh from a merged scene {@link TriMesh}. Returns a normalized
 * result instead of throwing on Recast build failure, so callers can branch
 * (and so init-vs-build failures stay distinguishable). {@link initNavmesh} must
 * have resolved first.
 */
export function generateNavmesh(
  mesh: TriMesh,
  config: NavmeshConfig = DEFAULT_NAVMESH_CONFIG,
): NavmeshResult {
  const result = generateSoloNavMesh(mesh.positions, mesh.indices, {
    cs: config.cs,
    ch: config.ch,
    walkableRadius: config.walkableRadiusVx,
    walkableHeight: config.walkableHeightVx,
    walkableClimb: config.walkableClimbVx,
  });
  if (!result.success) {
    return { success: false, error: result.error };
  }
  return { success: true, navmesh: new Navmesh(result.navMesh) };
}

/** Outcome of a path query, normalized to a plain DTO. */
export type PathResult = {
  /** Whether Detour produced a corridor from start to (near) end. */
  success: boolean;
  /** Straight-path corner points; empty when `success` is false. */
  points: Vec3[];
  /** Human-readable reason when `success` is false. */
  error?: string;
};

/**
 * A built navmesh plus a reusable query. Owns native (WASM) memory: call
 * {@link destroy} when done (a Sample does this in its dispose function).
 */
export class Navmesh {
  readonly navMesh: NavMesh;
  private readonly query: NavMeshQuery;

  constructor(navMesh: NavMesh) {
    this.navMesh = navMesh;
    this.query = new NavMeshQuery(navMesh);
  }

  /** Snap an arbitrary world point onto the nearest navmesh polygon. */
  closestPoint(point: Vec3): Vec3 | null {
    const res = this.query.findClosestPoint(point, {
      halfExtents: DEFAULT_HALF_EXTENTS,
    });
    if (!res.success) return null;
    return { x: res.point.x, y: res.point.y, z: res.point.z };
  }

  /** Compute a straight path from `start` to `end`, normalized to a DTO. */
  findPath(start: Vec3, end: Vec3): PathResult {
    const res = this.query.computePath(start, end, {
      halfExtents: DEFAULT_HALF_EXTENTS,
    });
    if (!res.success) {
      return {
        success: false,
        points: [],
        error: res.error?.name ?? "computePath failed",
      };
    }
    return {
      success: true,
      points: res.path.map((p) => ({ x: p.x, y: p.y, z: p.z })),
    };
  }

  /** Free the underlying WASM objects. Call exactly once (no double-free guard). */
  destroy(): void {
    this.query.destroy();
    this.navMesh.destroy();
  }
}

/** Planar (XZ) distance from a path's last point to the goal. */
export function pathEndDistanceXZ(points: Vec3[], goal: Vec3): number {
  if (points.length === 0) return Number.POSITIVE_INFINITY;
  const last = points[points.length - 1];
  return Math.hypot(last.x - goal.x, last.z - goal.z);
}

/**
 * True if ANY path corner falls inside the obstacle footprint. Used to assert
 * the robust property "the route does not cut through a blocked region" without
 * asserting an exact (drift-prone) point sequence.
 */
export function pathIntrudesAabbXZ(
  points: Vec3[],
  aabb: AabbXZ,
  margin = 0,
): boolean {
  return points.some((p) => pointInAabbXZ(p, aabb, margin));
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
