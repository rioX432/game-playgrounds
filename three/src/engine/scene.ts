/**
 * Reusable scene primitives: ground plane, box grid, and a light preset.
 *
 * Samples that just need a stage (a floor, some reference boxes, sane lighting)
 * create these via the helpers below instead of hand-rolling the same
 * boilerplate. Each helper returns a `PrimitiveSet`: a root `THREE.Group` added
 * to the scene plus a `dispose()` that removes the group AND frees every GPU
 * resource (geometry / material / texture) the helper created.
 *
 * Ownership rule: a `PrimitiveSet` owns ONLY what it created. `dispose()` never
 * traverses arbitrary scene descendants, so it can never free assets owned by
 * the sample. `dispose()` is idempotent (safe to call more than once).
 *
 * Note: the engine also disposes scene meshes on sample switch, but a
 * `PrimitiveSet` disposing its own resources keeps the module correct in
 * isolation (e.g. when a sample rebuilds its stage mid-run) and makes ownership
 * explicit.
 */

import {
  BoxGeometry,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
} from "three";
import type { ColorRepresentation, Material, Scene } from "three";

/**
 * A set of scene objects owned as a unit. `root` is a single Group already
 * added to the target scene; `dispose()` removes it and frees every GPU
 * resource the set created.
 */
export interface PrimitiveSet {
  /** The group holding all created objects, already added to the scene. */
  readonly root: Group;
  /** Remove the group from the scene and dispose all owned GPU resources. */
  dispose(): void;
}

/**
 * Collects disposer callbacks so cleanup can't be missed. A tiny local
 * convenience — NOT a global registry. Each helper tracks the resources it
 * creates here and runs them once on dispose.
 */
class CleanupStack {
  private readonly disposers: Array<() => void> = [];
  private disposed = false;

  /** Register a geometry/material/texture for disposal. */
  add(disposer: () => void): void {
    this.disposers.push(disposer);
  }

  /** Track a material (or material array), disposing each element + any maps. */
  trackMaterial(material: Material | Material[]): void {
    const list = Array.isArray(material) ? material : [material];
    for (const mat of list) {
      this.add(() => mat.dispose());
      // Three does NOT auto-dispose textures with materials. The helpers here
      // do not generate textures, but if a caller-provided material carries a
      // map we still free it to keep the ownership contract honest.
      const maybeMap = (mat as { map?: { dispose(): void } }).map;
      if (maybeMap) this.add(() => maybeMap.dispose());
    }
  }

  /** Run all disposers exactly once (idempotent). */
  run(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const d of this.disposers) d();
    this.disposers.length = 0;
  }
}

const DEFAULT_GROUND_SIZE = 60;
const DEFAULT_GROUND_COLOR = 0x2a3b2f;

export interface GroundOptions {
  /** Side length of the square ground plane in meters. */
  size?: number;
  /** Ground color. */
  color?: ColorRepresentation;
  /** Y position of the ground surface. Defaults to 0. */
  y?: number;
}

/**
 * Create a flat square ground plane lying on the XZ plane (Y up).
 *
 * The returned set owns the plane geometry and its material; `dispose()` frees
 * both and removes the group from the scene.
 */
export function createGround(
  scene: Scene,
  options: GroundOptions = {},
): PrimitiveSet {
  const size = options.size ?? DEFAULT_GROUND_SIZE;
  const color = options.color ?? DEFAULT_GROUND_COLOR;
  const y = options.y ?? 0;

  const cleanup = new CleanupStack();
  const root = new Group();
  root.name = "ground";

  const geometry = new PlaneGeometry(size, size);
  const material = new MeshStandardMaterial({ color });
  cleanup.add(() => geometry.dispose());
  cleanup.trackMaterial(material);

  const mesh = new Mesh(geometry, material);
  mesh.rotation.x = -Math.PI / 2; // lay flat on XZ
  mesh.position.y = y;
  root.add(mesh);

  scene.add(root);
  return makeSet(scene, root, cleanup);
}

const DEFAULT_GRID_COUNT = 6;
const DEFAULT_BOX_SIZE = 1.5;
const DEFAULT_GRID_SPACING = 3;
const DEFAULT_BOX_COLOR = 0x8a6d3b;

export interface BoxGridOptions {
  /** Number of boxes per side (count x count grid). Defaults to 6. */
  count?: number;
  /** Edge length of each cube in meters. */
  boxSize?: number;
  /** Center-to-center spacing between boxes in meters. */
  spacing?: number;
  /** Box color. */
  color?: ColorRepresentation;
  /**
   * Y position of each box's center. Defaults to half the box size, so the
   * cubes rest on a ground plane at y = 0.
   */
  y?: number;
}

/**
 * Create a `count x count` grid of equal cubes centered on the origin, as
 * spatial reference geometry.
 *
 * All cubes share ONE geometry and ONE material owned by the set (cheap, and
 * disposed exactly once). Because the cubes never outlive the set, this single
 * shared geometry/material needs no refcounting.
 */
export function createBoxGrid(
  scene: Scene,
  options: BoxGridOptions = {},
): PrimitiveSet {
  const count = options.count ?? DEFAULT_GRID_COUNT;
  const boxSize = options.boxSize ?? DEFAULT_BOX_SIZE;
  const spacing = options.spacing ?? DEFAULT_GRID_SPACING;
  const color = options.color ?? DEFAULT_BOX_COLOR;
  const y = options.y ?? boxSize / 2;

  const cleanup = new CleanupStack();
  const root = new Group();
  root.name = "box-grid";

  const geometry = new BoxGeometry(boxSize, boxSize, boxSize);
  const material = new MeshStandardMaterial({ color });
  cleanup.add(() => geometry.dispose());
  cleanup.trackMaterial(material);

  const offset = ((count - 1) * spacing) / 2; // center the grid on origin
  for (let ix = 0; ix < count; ix++) {
    for (let iz = 0; iz < count; iz++) {
      const box = new Mesh(geometry, material);
      box.position.set(ix * spacing - offset, y, iz * spacing - offset);
      root.add(box);
    }
  }

  scene.add(root);
  return makeSet(scene, root, cleanup);
}

export interface LightPresetOptions {
  /** Sky color of the hemisphere fill light. */
  skyColor?: ColorRepresentation;
  /** Ground color of the hemisphere fill light. */
  groundColor?: ColorRepresentation;
  /** Hemisphere fill intensity. */
  hemiIntensity?: number;
  /** Key (directional) light color. */
  keyColor?: ColorRepresentation;
  /** Key (directional) light intensity. */
  keyIntensity?: number;
  /** Position of the directional key light. */
  keyPosition?: [number, number, number];
  /** Optional scene background color to set (left untouched if omitted). */
  background?: ColorRepresentation;
}

const DEFAULT_HEMI_SKY = 0xbfd4ff;
const DEFAULT_HEMI_GROUND = 0x202020;
const DEFAULT_HEMI_INTENSITY = 0.9;
const DEFAULT_KEY_COLOR = 0xffffff;
const DEFAULT_KEY_INTENSITY = 1.4;
const DEFAULT_KEY_POSITION: [number, number, number] = [5, 10, 4];

/**
 * Create a sane default lighting rig: a hemisphere fill plus a directional key
 * light. Optionally sets the scene background color.
 *
 * Lights have no GPU buffers to free, so `dispose()` only removes them from the
 * scene (by removing the group). The background color is NOT reverted on
 * dispose because the engine replaces the Scene per sample.
 */
export function createLightPreset(
  scene: Scene,
  options: LightPresetOptions = {},
): PrimitiveSet {
  // Lights own no GPU buffers, but keep the CleanupStack for a uniform shape.
  const cleanup = new CleanupStack();
  const root = new Group();
  root.name = "light-preset";

  const hemi = new HemisphereLight(
    options.skyColor ?? DEFAULT_HEMI_SKY,
    options.groundColor ?? DEFAULT_HEMI_GROUND,
    options.hemiIntensity ?? DEFAULT_HEMI_INTENSITY,
  );
  root.add(hemi);

  const dir = new DirectionalLight(
    options.keyColor ?? DEFAULT_KEY_COLOR,
    options.keyIntensity ?? DEFAULT_KEY_INTENSITY,
  );
  const [kx, ky, kz] = options.keyPosition ?? DEFAULT_KEY_POSITION;
  dir.position.set(kx, ky, kz);
  root.add(dir);

  if (options.background !== undefined) {
    scene.background = new Color(options.background);
  }

  scene.add(root);
  return makeSet(scene, root, cleanup);
}

/**
 * Build a `PrimitiveSet` from a root group + cleanup stack. `dispose()` removes
 * the group from the scene and runs the cleanup once (idempotent). It does NOT
 * traverse the group's descendants — only the explicitly tracked resources are
 * disposed, so it can never free objects the set does not own.
 */
function makeSet(
  scene: Scene,
  root: Group,
  cleanup: CleanupStack,
): PrimitiveSet {
  let removed = false;
  return {
    root,
    dispose(): void {
      if (!removed) {
        removed = true;
        scene.remove(root);
        // Detach children so a stale reference can't keep them in another tree.
        root.clear();
      }
      cleanup.run();
    },
  };
}

export interface StageOptions {
  ground?: GroundOptions;
  boxGrid?: BoxGridOptions;
  lights?: LightPresetOptions;
}

/**
 * Convenience: build a standard stage (light preset + ground + box grid) in one
 * call. Returns a single `PrimitiveSet` whose `dispose()` tears down all three.
 */
export function createStage(
  scene: Scene,
  options: StageOptions = {},
): PrimitiveSet {
  const parts: PrimitiveSet[] = [
    createLightPreset(scene, options.lights),
    createGround(scene, options.ground),
    createBoxGrid(scene, options.boxGrid),
  ];

  const root = new Group();
  root.name = "stage";
  // Re-parent each part's root under one stage group for a single handle.
  for (const part of parts) {
    root.add(part.root);
  }
  scene.add(root);

  let disposed = false;
  return {
    root,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      scene.remove(root);
      // Dispose each part (frees its GPU resources); root.clear() detaches the
      // (already-emptied) part groups from the stage handle.
      for (const part of parts) part.dispose();
      root.clear();
    },
  };
}
