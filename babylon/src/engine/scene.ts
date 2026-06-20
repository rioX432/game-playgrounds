import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";
import "@babylonjs/core/Meshes/Builders/groundBuilder"; // side-effect: CreateGround
import "@babylonjs/core/Meshes/Builders/boxBuilder"; // side-effect: CreateBox

/**
 * Reusable scene primitives for the Babylon playground: a ground plane, a box
 * grid, and a two-light preset. These cut the boilerplate every sample copies
 * (lighting + a floor + some props) into a few idiomatic factory calls.
 *
 * ## Ownership / disposal design (read before adding `dispose()` calls)
 *
 * The gallery disposes the ENTIRE `Scene` on every sample switch, and
 * `scene.dispose()` already frees meshes, materials, textures, and lights. So
 * for the normal sample lifetime you do NOT need to call any of the `dispose()`
 * methods below — building the primitives and letting the scene be disposed is
 * leak-safe by construction.
 *
 * Each factory still returns an object with a `dispose()` whose only purpose is
 * EARLY teardown within a still-live scene (e.g. clearing a box grid while the
 * sample keeps running). Those `dispose()` methods are:
 *   - **own-what-you-create**: they free ONLY the meshes/materials this factory
 *     created. They never traverse the scene graph or dispose arbitrary nodes,
 *     and never touch anything the caller passed in or shares.
 *   - **idempotent**: calling twice is a no-op.
 *   - **optional**: you are not required to call them before `scene.dispose()`.
 *
 * All factories follow Babylon idioms (`MeshBuilder`, `StandardMaterial`,
 * `HemisphericLight` + `DirectionalLight`), matching the inline code in the
 * samples they replace.
 */

// --- Ground -----------------------------------------------------------------

const DEFAULT_GROUND_SIZE = 60;
const DEFAULT_GROUND_COLOR = new Color3(0.35, 0.5, 0.35);

export interface GroundOptions {
  /** Side length of the square ground (units). Default 60. */
  size?: number;
  /** Diffuse color of the ground material. Default a muted green. */
  color?: Color3;
  /** Mesh/material name prefix (lets multiple grounds coexist). Default "ground". */
  name?: string;
}

/** A ground plane plus its owned material, with idempotent early teardown. */
export interface GroundPrimitive {
  readonly mesh: Mesh;
  readonly material: StandardMaterial;
  /** Dispose the ground mesh + its material. Idempotent. Optional (see file doc). */
  dispose(): void;
}

/**
 * Create a flat square ground with a flat-colored {@link StandardMaterial}.
 * The returned object owns both the mesh and the material it created.
 */
export function createGround(
  scene: Scene,
  options: GroundOptions = {},
): GroundPrimitive {
  const name = options.name ?? "ground";
  const size = options.size ?? DEFAULT_GROUND_SIZE;

  const mesh = MeshBuilder.CreateGround(
    name,
    { width: size, height: size },
    scene,
  );
  const material = new StandardMaterial(`${name}Mat`, scene);
  material.diffuseColor = (options.color ?? DEFAULT_GROUND_COLOR).clone();
  mesh.material = material;

  let disposed = false;
  return {
    mesh,
    material,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      mesh.dispose();
      material.dispose();
    },
  };
}

// --- Box grid ---------------------------------------------------------------

const DEFAULT_GRID_COLUMNS = 4;
const DEFAULT_GRID_ROWS = 4;
const DEFAULT_BOX_SIZE = 2;
const DEFAULT_BOX_SPACING = 5;
const DEFAULT_BOX_COLOR = new Color3(0.8, 0.55, 0.3);

export interface BoxGridOptions {
  /** Number of columns (along X). Default 4. */
  columns?: number;
  /** Number of rows (along Z). Default 4. */
  rows?: number;
  /** Cube edge length (units). Default 2. */
  boxSize?: number;
  /** Center-to-center distance between boxes (units). Default 5. */
  spacing?: number;
  /** Diffuse color shared by every box. Default a warm orange. */
  color?: Color3;
  /** Grid center on the ground plane. Default origin. */
  center?: Vector3;
  /** Mesh/material name prefix. Default "box". */
  name?: string;
}

/** A grid of boxes sharing one owned material, with idempotent early teardown. */
export interface BoxGridPrimitive {
  /** The created box meshes, row-major. */
  readonly boxes: readonly Mesh[];
  /** The single material shared by every box (owned by this primitive). */
  readonly material: StandardMaterial;
  /** Dispose every box mesh + the shared material. Idempotent. Optional. */
  dispose(): void;
}

/**
 * Create a `columns × rows` grid of boxes centered on `center`, each resting on
 * the ground (bottom at y=0). All boxes share one {@link StandardMaterial}. The
 * returned object owns the boxes and that material.
 */
export function createBoxGrid(
  scene: Scene,
  options: BoxGridOptions = {},
): BoxGridPrimitive {
  const name = options.name ?? "box";
  const columns = Math.max(0, Math.floor(options.columns ?? DEFAULT_GRID_COLUMNS));
  const rows = Math.max(0, Math.floor(options.rows ?? DEFAULT_GRID_ROWS));
  const boxSize = options.boxSize ?? DEFAULT_BOX_SIZE;
  const spacing = options.spacing ?? DEFAULT_BOX_SPACING;
  const center = options.center ?? Vector3.Zero();

  const material = new StandardMaterial(`${name}Mat`, scene);
  material.diffuseColor = (options.color ?? DEFAULT_BOX_COLOR).clone();

  // Offsets so the grid is centered on `center` regardless of column/row count.
  const xOffset = ((columns - 1) * spacing) / 2;
  const zOffset = ((rows - 1) * spacing) / 2;

  const boxes: Mesh[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const box = MeshBuilder.CreateBox(
        `${name}_${r}_${c}`,
        { size: boxSize },
        scene,
      );
      box.position.set(
        center.x + c * spacing - xOffset,
        center.y + boxSize / 2,
        center.z + r * spacing - zOffset,
      );
      box.material = material;
      boxes.push(box);
    }
  }

  let disposed = false;
  return {
    boxes,
    material,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const box of boxes) box.dispose();
      material.dispose();
    },
  };
}

// --- Light preset -----------------------------------------------------------

const DEFAULT_HEMI_INTENSITY = 0.7;
const DEFAULT_SUN_INTENSITY = 0.6;
const DEFAULT_SUN_DIRECTION = new Vector3(-0.5, -1, -0.5);

export interface LightPresetOptions {
  /** Ambient hemispheric fill intensity. Default 0.7. */
  hemiIntensity?: number;
  /** Directional "sun" intensity. Default 0.6. */
  sunIntensity?: number;
  /** Direction the sun light travels. Default (-0.5, -1, -0.5). */
  sunDirection?: Vector3;
  /** Name prefix for the two lights. Default "preset". */
  name?: string;
}

/** A hemispheric + directional light pair, with idempotent early teardown. */
export interface LightPreset {
  /** Ambient fill light. */
  readonly hemispheric: HemisphericLight;
  /** Key/directional "sun" light. */
  readonly directional: DirectionalLight;
  /** Dispose both lights. Idempotent. Optional (see file doc). */
  dispose(): void;
}

/**
 * Create the standard outdoor light preset used across samples: a soft
 * hemispheric fill plus a directional "sun" for shape and shadow direction.
 * The returned object owns both lights.
 */
export function createLightPreset(
  scene: Scene,
  options: LightPresetOptions = {},
): LightPreset {
  const name = options.name ?? "preset";

  const hemispheric = new HemisphericLight(
    `${name}Hemi`,
    new Vector3(0, 1, 0),
    scene,
  );
  hemispheric.intensity = options.hemiIntensity ?? DEFAULT_HEMI_INTENSITY;

  const directional = new DirectionalLight(
    `${name}Sun`,
    (options.sunDirection ?? DEFAULT_SUN_DIRECTION).clone(),
    scene,
  );
  directional.intensity = options.sunIntensity ?? DEFAULT_SUN_INTENSITY;

  let disposed = false;
  return {
    hemispheric,
    directional,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      hemispheric.dispose();
      directional.dispose();
    },
  };
}
