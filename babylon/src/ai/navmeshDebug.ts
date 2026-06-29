// Minimal navmesh-debug visualization helper (Ch4 foundation).
//
// Later NPC/AI samples render the computed navmesh so the walkable area and the
// holes carved by blockers are visible. Babylon's plugin produces a debug mesh of
// the navmesh polygons via `createDebugNavMesh`; this wraps it with a translucent,
// unlit material lifted slightly off the ground to avoid z-fighting.

import { Color3 } from "@babylonjs/core/Maths/math.color";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";
import type { RecastJSPlugin } from "@babylonjs/core/Navigation/Plugins/recastJSPlugin";

/** Appearance knobs for {@link createNavMeshDebug}. */
export interface NavMeshDebugOptions {
  /** Flat emissive tint of the navmesh overlay. */
  color?: Color3;
  /** Overlay opacity (0 = invisible, 1 = opaque). */
  alpha?: number;
  /** Vertical lift to avoid z-fighting with the ground, world units. */
  yOffset?: number;
}

const DEFAULT_DEBUG_COLOR = new Color3(0.2, 0.6, 1);
const DEFAULT_DEBUG_ALPHA = 0.25;
const DEFAULT_Y_OFFSET = 0.05;

/**
 * Build a translucent debug overlay of the plugin's current navmesh and add it to
 * `scene`. The returned mesh is non-pickable; dispose it (or its scene) to remove.
 */
export function createNavMeshDebug(
  plugin: RecastJSPlugin,
  scene: Scene,
  options: NavMeshDebugOptions = {},
): Mesh {
  const mesh = plugin.createDebugNavMesh(scene);

  const material = new StandardMaterial("nav-debug-mat", scene);
  material.emissiveColor = options.color ?? DEFAULT_DEBUG_COLOR;
  material.disableLighting = true;
  material.alpha = options.alpha ?? DEFAULT_DEBUG_ALPHA;
  mesh.material = material;

  mesh.position.y += options.yOffset ?? DEFAULT_Y_OFFSET;
  mesh.isPickable = false;
  return mesh;
}
