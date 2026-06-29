// Chapter 4 (NPC/AI) foundation — pure navmesh core for Babylon.
//
// Babylon represents the "engine-integrated wrapper" axis of the Ch4 control
// experiment: the SAME Recast/Detour core as Three, reached through Babylon's
// `RecastJSPlugin` (createNavMesh / computePath) rather than the raw library. This
// module isolates that wrapper behind a render-independent API so navmesh
// generation + path queries are unit-testable under `NullEngine` with no DOM/GPU,
// mirroring the no-DOM purity of the render `probe` in `src/measure`.
//
// Path output is normalised to a plain `Vec3` DTO (not Babylon's `Vector3`) so the
// query result type is comparable across engines without leaking engine types.

import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { RecastJSPlugin } from "@babylonjs/core/Navigation/Plugins/recastJSPlugin";
import type { INavMeshParameters } from "@babylonjs/core/Navigation/INavigationEngine";
// Side-effect imports for the builders used to materialise a NavSceneSpec.
import "@babylonjs/core/Meshes/Builders/groundBuilder";
import "@babylonjs/core/Meshes/Builders/boxBuilder";
import { loadRecast, type RecastModule } from "./recast";

/** Engine-neutral 3D point DTO — the common navmesh query result type. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** An axis-aligned blocker: a box resting on the ground that carves the navmesh. */
export interface NavBox {
  /** World-space center of the box. */
  center: Vec3;
  /** Full extents (x = width, y = height, z = depth). */
  size: Vec3;
}

/** Numeric, render-independent description of a navmesh world. */
export interface NavSceneSpec {
  /** Flat ground plane on the xz-plane at y = 0. */
  ground: { width: number; depth: number };
  /** Boxes that obstruct the walkable area. */
  blockers: NavBox[];
}

/**
 * Default Recast build parameters, tuned on a ~20×20 ground.
 *
 * Note the unit subtlety that drives navmesh quality: `cs`/`ch` are in world units,
 * but `walkable*` are in VOXELS (multiples of `cs`/`ch`). With `cs = 0.2`,
 * `walkableRadius: 4` erodes the walkable area ~0.8 world units away from every
 * obstruction — a realistic agent radius that keeps computed paths clear of blocker
 * footprints (a `walkableRadius` of 1 would erode only 0.2 world units). A small
 * `walkableClimb` means a box taller than ~0.2 world units reads as a wall to route
 * around rather than a ramp to walk over. Callers may override per sample.
 */
export const DEFAULT_NAV_PARAMS: INavMeshParameters = {
  cs: 0.2,
  ch: 0.2,
  walkableSlopeAngle: 35,
  walkableHeight: 1,
  walkableClimb: 1,
  walkableRadius: 4,
  maxEdgeLen: 12,
  maxSimplificationError: 1.3,
  minRegionArea: 8,
  mergeRegionArea: 20,
  maxVertsPerPoly: 6,
  detailSampleDist: 6,
  detailSampleMaxError: 1,
};

const toVector3 = (v: Vec3): Vector3 => new Vector3(v.x, v.y, v.z);
const toVec3 = (v: Vector3): Vec3 => ({ x: v.x, y: v.y, z: v.z });

/**
 * Build a navmesh from existing scene geometry through Babylon's engine-integrated
 * plugin. Shared by both the headless core and the visualization path (a later
 * sample's `mount` calls this on its real scene meshes). Returns the live plugin so
 * callers can `computePath`, attach a debug mesh, or query closest points.
 */
export function createNavMesh(
  recast: RecastModule,
  meshes: Mesh[],
  params: INavMeshParameters = DEFAULT_NAV_PARAMS,
): RecastJSPlugin {
  const plugin = new RecastJSPlugin(recast);
  plugin.createNavMesh(meshes, params);
  return plugin;
}

/**
 * Materialise a {@link NavSceneSpec} into concrete meshes. Exposed so a
 * visualization sample can render exactly the world the headless test exercises.
 */
export function buildSpecMeshes(
  scene: Scene,
  spec: NavSceneSpec,
): { ground: Mesh; blockers: Mesh[] } {
  const ground = MeshBuilder.CreateGround(
    "nav-ground",
    { width: spec.ground.width, height: spec.ground.depth },
    scene,
  );
  const blockers = spec.blockers.map((b, i) => {
    const box = MeshBuilder.CreateBox(
      `nav-blocker-${i}`,
      { width: b.size.x, height: b.size.y, depth: b.size.z },
      scene,
    );
    box.position.set(b.center.x, b.center.y, b.center.z);
    return box;
  });
  return { ground, blockers };
}

/** A render-independent navmesh query handle backed by a private NullEngine scene. */
export interface NavQuery {
  /** The live Babylon plugin (engine-wrapped Recast/Detour). */
  readonly plugin: RecastJSPlugin;
  /** The blockers this navmesh was carved with (for assertions / debugging). */
  readonly blockers: NavBox[];
  /** Snap a world point onto the navmesh (closest reachable point). */
  closestPoint(p: Vec3): Vec3;
  /** Straight (corridor) path from start to end; empty if unreachable. */
  computePath(start: Vec3, end: Vec3): Vec3[];
  /** Tear down the private engine/scene/plugin. */
  dispose(): void;
}

/**
 * Build a fully self-contained navmesh from a numeric spec under a private
 * `NullEngine` — no DOM, no GPU, no shared scene. This is the headless entry point
 * the vitest proof drives and the canonical "pure AI core" for the Babylon side.
 */
export async function buildHeadlessNav(
  spec: NavSceneSpec,
  params: INavMeshParameters = DEFAULT_NAV_PARAMS,
): Promise<NavQuery> {
  const recast = await loadRecast();
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const { ground, blockers } = buildSpecMeshes(scene, spec);
  const plugin = createNavMesh(recast, [ground, ...blockers], params);

  return {
    plugin,
    blockers: spec.blockers,
    closestPoint: (p) => toVec3(plugin.getClosestPoint(toVector3(p))),
    computePath: (start, end) =>
      plugin.computePath(toVector3(start), toVector3(end)).map(toVec3),
    dispose: () => {
      plugin.dispose();
      scene.dispose();
      engine.dispose();
    },
  };
}

/** Total Euclidean length of a polyline path. */
export function pathLength(path: Vec3[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    total += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  }
  return total;
}

/**
 * True if point `p` lies inside a box's xz footprint, optionally shrunk/grown by
 * `margin` (positive = grow). Used to assert a path does not intrude a blocked AABB
 * and, later, by guard AI to test obstacle avoidance.
 */
export function isInsideFootprintXZ(box: NavBox, p: Vec3, margin = 0): boolean {
  const hx = box.size.x / 2 + margin;
  const hz = box.size.z / 2 + margin;
  return (
    Math.abs(p.x - box.center.x) <= hx && Math.abs(p.z - box.center.z) <= hz
  );
}
