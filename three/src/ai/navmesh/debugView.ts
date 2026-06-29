// Minimal navmesh-debug visualization helper, shared by later Ch4 samples
// (navmesh-pathfind, guard-ai). This is the ONLY navmesh module that imports
// three.js: the pure core (geometry/navmesh/scene) stays render-independent so
// it can be unit-tested headless. A Sample calls this inside mount(ctx).

import {
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  Line,
  LineBasicMaterial,
  MeshBasicMaterial,
  type Object3D,
  type Scene,
} from "three";
import { NavMeshHelper } from "@recast-navigation/three";
import type { Navmesh } from "./navmesh";
import type { Vec3 } from "./geometry";

const NAVMESH_COLOR = 0x2a6f97;
const NAVMESH_OPACITY = 0.4;
const PATH_COLOR = 0xffd166;
const PATH_LIFT_Y = 0.05; // raise the path line slightly above the navmesh
// Upper bound on path corners (matches recast computePath's default
// maxStraightPathPoints), so the line buffer is allocated once and reused.
const MAX_PATH_POINTS = 256;

/** Handle returned by {@link createNavmeshDebug}; lets a Sample tear it down. */
export type NavmeshDebug = {
  /** Translucent overlay of the walkable navmesh surface. */
  navmeshHelper: Object3D;
  /** Replace the drawn path line with a new set of corner points. */
  setPath(points: Vec3[]): void;
  /** Remove all debug objects from the scene and free their GPU resources. */
  dispose(): void;
};

/**
 * Add a translucent navmesh overlay (plus a re-settable path line) to `scene`.
 * Returns a handle whose `dispose()` removes everything and releases buffers —
 * the caller wires it into the Sample's dispose function.
 */
export function createNavmeshDebug(scene: Scene, navmesh: Navmesh): NavmeshDebug {
  const navmeshMaterial = new MeshBasicMaterial({
    color: NAVMESH_COLOR,
    transparent: true,
    opacity: NAVMESH_OPACITY,
    depthWrite: false,
  });
  const navmeshHelper = new NavMeshHelper(navmesh.navMesh, {
    navMeshMaterial: navmeshMaterial,
  });
  scene.add(navmeshHelper);

  // One pre-allocated, GPU-dynamic position buffer reused across re-paths (the
  // guard-ai sample re-queries every frame); setPath rewrites the array and
  // moves the draw range rather than allocating a new GL buffer each call.
  const pathGeometry = new BufferGeometry();
  const pathPositions = new BufferAttribute(
    new Float32Array(MAX_PATH_POINTS * 3),
    3,
  );
  pathPositions.setUsage(DynamicDrawUsage);
  pathGeometry.setAttribute("position", pathPositions);
  pathGeometry.setDrawRange(0, 0);
  const pathMaterial = new LineBasicMaterial({ color: PATH_COLOR });
  const pathLine = new Line(pathGeometry, pathMaterial);
  scene.add(pathLine);

  const setPath = (points: Vec3[]): void => {
    const count = Math.min(points.length, MAX_PATH_POINTS);
    const array = pathPositions.array as Float32Array;
    for (let i = 0; i < count; i++) {
      array[i * 3] = points[i].x;
      array[i * 3 + 1] = points[i].y + PATH_LIFT_Y;
      array[i * 3 + 2] = points[i].z;
    }
    pathPositions.needsUpdate = true;
    pathGeometry.setDrawRange(0, count);
    pathGeometry.computeBoundingSphere();
  };

  return {
    navmeshHelper,
    setPath,
    dispose() {
      scene.remove(navmeshHelper);
      scene.remove(pathLine);
      navmeshHelper.navMeshGeometry.dispose();
      navmeshMaterial.dispose();
      pathGeometry.dispose();
      pathMaterial.dispose();
    },
  };
}
