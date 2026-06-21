import characterController from "./01-character-controller/index";
import physicsGrabThrow from "./02-physics-grab-throw/index";
import paintOnMesh from "./03-paint-on-mesh/index";
import firstPersonController from "./04-first-person-controller/index";
import spatialAudio from "./05-spatial-audio/index";
import hideAndSeekDisguise from "./06-hide-and-seek-disguise/index";
import redLightGreenLight from "./08-red-light-green-light/index";
import coopCarry from "./09-coop-carry/index";
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
  firstPersonController,
  spatialAudio,
  hideAndSeekDisguise,
  redLightGreenLight,
  coopCarry,
];
