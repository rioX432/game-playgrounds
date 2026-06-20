import characterController from "./01-character-controller/index";
import physicsGrabThrow from "./02-physics-grab-throw/index";
import paintOnMesh from "./03-paint-on-mesh/index";
import type { Sample } from "./types";

/**
 * The single source of truth for which samples the gallery shows.
 * To add a sample: implement it under src/samples/NN-id/index.ts (default
 * export a `Sample`), import it here, and append it to this array.
 */
export const samples: Sample[] = [
  characterController,
  physicsGrabThrow,
  paintOnMesh,
];
