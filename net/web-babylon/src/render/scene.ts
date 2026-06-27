// Static scene scaffolding: ground grid, lights, and a fixed angled-overhead
// ArcRotateCamera framing the whole arena so every interpolated remote player
// stays visible. The camera is intentionally NOT given attachControl: this
// sample's only input is movement (net/input.ts), and a draggable camera would
// fight the keyboard. Babylon is left-handed by default; we keep that (the issue
// asks to absorb the engine difference, not paper over it with a handedness
// flip) — the netcode is identical to web-three, only this layer differs.

import type { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { CreateLineSystem } from "@babylonjs/core/Meshes/Builders/linesBuilder";
import { ARENA_HALF } from "../config";

// Dark scene clear, matching the page background (#0b0d12) so the HUD reads.
const CLEAR_COLOR = new Color4(0.043, 0.051, 0.071, 1);
const GRID_COLOR = Color3.FromHexString("#3a4250");
const AMBIENT_INTENSITY = 0.7;
const SUN_INTENSITY = 0.6;
// Match web-three's PerspectiveCamera vertical FOV (55deg) so both clients frame
// the arena identically — Babylon's ArcRotateCamera.fov defaults to ~0.8 rad.
const CAMERA_FOV_RAD = (55 * Math.PI) / 180;

export interface SceneBundle {
  scene: Scene;
  /** Dispose the static GPU resources this scaffold created (grid geometry). */
  dispose: () => void;
}

/** Build the arena grid as a single LinesMesh spanning [-ARENA_HALF, +ARENA_HALF]. */
function buildGrid(scene: Scene) {
  const h = ARENA_HALF;
  const lines: Vector3[][] = [];
  for (let i = -h; i <= h; i++) {
    lines.push([new Vector3(i, 0, -h), new Vector3(i, 0, h)]); // along z
    lines.push([new Vector3(-h, 0, i), new Vector3(h, 0, i)]); // along x
  }
  const grid = CreateLineSystem("arenaGrid", { lines }, scene);
  grid.color = GRID_COLOR;
  grid.isPickable = false;
  return grid;
}

export function createScene(engine: Engine): SceneBundle {
  const scene = new Scene(engine);
  scene.clearColor = CLEAR_COLOR;

  const grid = buildGrid(scene);

  // Hemispheric fill + a key directional, mirroring web-three's ambient + sun.
  const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
  hemi.intensity = AMBIENT_INTENSITY;
  const sun = new DirectionalLight("sun", new Vector3(-0.5, -1, -0.5), scene);
  sun.intensity = SUN_INTENSITY;

  // Fixed angled-overhead framing of the origin; the whole arena fits in frame.
  // setPosition derives alpha/beta/radius from a world position, matching the
  // web-three camera placement (0, ~1.4H, ~1.6H) looking at the origin; fov is
  // matched too so both clients frame the arena identically.
  const camera = new ArcRotateCamera(
    "arena",
    0,
    0,
    1,
    Vector3.Zero(),
    scene,
  );
  camera.setPosition(new Vector3(0, ARENA_HALF * 1.4, ARENA_HALF * 1.6));
  camera.fov = CAMERA_FOV_RAD;
  scene.activeCamera = camera;

  // Lights/camera are scene-owned and freed by scene.dispose() in main; this
  // scaffold only needs to release the grid mesh it explicitly created.
  const dispose = (): void => {
    grid.dispose();
  };

  return { scene, dispose };
}
