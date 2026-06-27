// Static scene scaffolding: ground grid, lights, and an overhead camera framing
// the whole arena so every interpolated remote player stays visible.

import {
  AmbientLight,
  DirectionalLight,
  GridHelper,
  type Material,
  PerspectiveCamera,
  Scene,
} from "three";
import { ARENA_HALF } from "../config";

export interface SceneBundle {
  scene: Scene;
  camera: PerspectiveCamera;
  /** Dispose the static GPU resources this scaffold created (grid geometry). */
  dispose: () => void;
}

export function createScene(aspect: number): SceneBundle {
  const scene = new Scene();

  const arena = ARENA_HALF * 2;
  const grid = new GridHelper(arena, arena, 0x3a4250, 0x222833);
  scene.add(grid);

  scene.add(new AmbientLight(0xffffff, 0.6));
  const sun = new DirectionalLight(0xffffff, 0.9);
  sun.position.set(10, 20, 10);
  scene.add(sun);

  // Angled overhead view of the origin; the arena fits comfortably in frame.
  const camera = new PerspectiveCamera(55, aspect, 0.1, 500);
  camera.position.set(0, ARENA_HALF * 1.4, ARENA_HALF * 1.6);
  camera.lookAt(0, 0, 0);

  // Lights hold no GPU buffers; the grid (LineSegments) owns geometry+material.
  const dispose = (): void => {
    grid.geometry.dispose();
    (grid.material as Material).dispose();
  };

  return { scene, camera, dispose };
}
