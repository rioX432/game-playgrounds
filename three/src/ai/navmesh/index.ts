// Ch4 navmesh foundation (Three.js = "raw / direct library" integration).
// Pure, render-independent core: geometry + scene + navmesh wrapper. The
// Three.js debug overlay (debugView) is imported directly by samples, not
// re-exported here, to keep this barrel free of any three.js dependency.

export type { AabbXZ, TriMesh, Vec3 } from "./geometry";
export {
  boxFootprintXZ,
  boxTriMesh,
  mergeTriMeshes,
  pointInAabbXZ,
} from "./geometry";
export type { NavmeshConfig, NavmeshResult, PathResult } from "./navmesh";
export {
  DEFAULT_NAVMESH_CONFIG,
  Navmesh,
  generateNavmesh,
  initNavmesh,
  pathEndDistanceXZ,
  pathIntrudesAabbXZ,
} from "./navmesh";
export type { ObstacleCourse } from "./scene";
export { buildObstacleCourse } from "./scene";
