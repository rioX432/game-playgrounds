// Shared stress-scene construction (#173). Extracted from the sample's mount()
// so the WebGL `Engine` gallery path AND the `WebGPUEngine` measure orchestrator
// build the SAME scene from the SAME constants — a Babylon `Scene` is engine
// agnostic, so the only thing that differs across the two measure runs is the
// engine backend, never the scene. Forking a second scene with its own constants
// would make the WebGL-vs-WebGPU numbers non-comparable, so we don't.

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import { PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";
import "@babylonjs/core/Meshes/Builders/groundBuilder";
import "@babylonjs/core/Meshes/Builders/boxBuilder";
import "@babylonjs/core/Physics/physicsEngineComponent";

import { createHavokPlugin } from "../../engine/havok";
import { computeSpawnPositions } from "./spawn";

// --- Scene constants (single-sourced so both engines stay comparable). ---
export const GRAVITY_Y = -9.81;
export const BOX_HALF = 0.3;
export const BATCH_SIZE = 100;
export const MAX_BODIES = 2000;
export const FLOOR_SIZE = 24;

const CAMERA_ALPHA = -Math.PI / 2;
const CAMERA_BETA = Math.PI / 3;
const CAMERA_RADIUS = 32;
const CAMERA_TARGET = new Vector3(0, 2, 0);
const SUN_DIR = new Vector3(-0.4, -1, -0.3);
const SUN_INTENSITY = 0.8;
const BOX_COLOR = new Color3(1, 0.53, 0.27);
const FLOOR_COLOR = new Color3(0.22, 0.22, 0.26);
const CLEAR_COLOR: readonly [number, number, number, number] = [0.05, 0.06, 0.08, 1];

/** A live physics world: spawn/clear controls over the dynamic bodies. */
export interface StressBodies {
  /** Spawn `n` boxes (capped at {@link MAX_BODIES}) from the seeded scatter. */
  spawnBodies(n: number): void;
  /** Dispose every dynamic body and reset the count to zero. */
  clearAll(): void;
  /** Current number of live dynamic bodies. */
  readonly count: number;
  /** Tear down all bodies + the hidden template (floor/scene owned by caller). */
  dispose(): void;
}

/**
 * Build the static visuals shared by both engines: clear color, framing camera
 * (with control attached), lights, and the box material. Synchronous so the
 * gallery has an active camera the instant the sample mounts (no pre-Havok
 * "no camera defined" frames). Returns the box material the physics build reuses.
 */
export function setupStressVisuals(
  scene: Scene,
  canvas: HTMLCanvasElement,
): { boxMat: StandardMaterial } {
  scene.clearColor.set(...CLEAR_COLOR);

  const camera = new ArcRotateCamera(
    "stressCam",
    CAMERA_ALPHA,
    CAMERA_BETA,
    CAMERA_RADIUS,
    CAMERA_TARGET.clone(),
    scene,
  );
  camera.attachControl(canvas, true);

  new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
  const sun = new DirectionalLight("sun", SUN_DIR.clone(), scene);
  sun.intensity = SUN_INTENSITY;

  const boxMat = new StandardMaterial("stressBoxMat", scene);
  boxMat.diffuseColor = BOX_COLOR.clone();

  return { boxMat };
}

/**
 * Asynchronously enable Havok physics on `scene` and build the floor + a hidden
 * template box, returning spawn/clear controls. The Havok WASM loads on demand;
 * `isAborted()` is checked AFTER the await and BEFORE `enablePhysics` so a caller
 * that tore down mid-load can have the orphan plugin disposed (it was never
 * handed to a scene that would dispose it) — returns `null` in that case.
 */
export async function enableStressPhysics(
  scene: Scene,
  boxMat: StandardMaterial,
  rng: () => number,
  isAborted: () => boolean,
): Promise<StressBodies | null> {
  const plugin = await createHavokPlugin();
  if (isAborted()) {
    plugin.dispose();
    return null;
  }
  scene.enablePhysics(new Vector3(0, GRAVITY_Y, 0), plugin);

  const floor = MeshBuilder.CreateGround(
    "floor",
    { width: FLOOR_SIZE, height: FLOOR_SIZE },
    scene,
  );
  const floorMat = new StandardMaterial("stressFloorMat", scene);
  floorMat.diffuseColor = FLOOR_COLOR.clone();
  floor.material = floorMat;
  new PhysicsAggregate(floor, PhysicsShapeType.BOX, { mass: 0 }, scene);

  // Hidden template the batch clones from (so we build geometry once).
  const template = MeshBuilder.CreateBox("boxTemplate", { size: BOX_HALF * 2 }, scene);
  template.material = boxMat;
  template.setEnabled(false);

  const bodies: { mesh: Mesh; aggregate: PhysicsAggregate }[] = [];

  const spawnBodies = (n: number): void => {
    const room = MAX_BODIES - bodies.length;
    const requested = Math.min(n, room);
    if (requested <= 0) return;
    for (const p of computeSpawnPositions(requested, rng)) {
      const box = template.clone(`box${bodies.length}`, null) as Mesh;
      box.setEnabled(true);
      box.position.set(p.x, p.y, p.z);
      const aggregate = new PhysicsAggregate(
        box,
        PhysicsShapeType.BOX,
        { mass: 1, restitution: 0.1 },
        scene,
      );
      bodies.push({ mesh: box, aggregate });
    }
  };

  const clearAll = (): void => {
    for (const b of bodies) {
      b.aggregate.dispose();
      b.mesh.dispose();
    }
    bodies.length = 0;
  };

  return {
    spawnBodies,
    clearAll,
    get count(): number {
      return bodies.length;
    },
    dispose(): void {
      clearAll();
      template.dispose();
    },
  };
}
