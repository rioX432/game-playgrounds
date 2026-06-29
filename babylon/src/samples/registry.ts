import type { Sample } from "./types";
import { sample01 } from "./01-character-controller/index";
import { sample02 } from "./02-physics-grab-throw/index";
import { sample03 } from "./03-paint-on-mesh/index";
import { sample04 } from "./04-first-person-controller/index";
import { sample05 } from "./05-spatial-audio/index";
import { sample06 } from "./06-hide-and-seek-disguise/index";
import { sample07 } from "./07-ragdoll-core/index";
import { sample08 } from "./08-red-light-green-light/index";
import { sample09 } from "./09-coop-carry/index";
import { sample10 } from "./10-emote-wheel/index";
import { sample11 } from "./11-top-down-twin-stick/index";
import { sample12a } from "./12a-spherical-gravity/index";
import { sample12b } from "./12b-tiny-planet/index";
import { sample13 } from "./13-stress-bodies/index";
import { sample14 } from "./14-navmesh-pathfind/index";

/**
 * The ordered list of all playground samples. `/dev-all` appends a new entry
 * here after implementing the Sample in its own folder under `src/samples/`.
 */
export const samples: Sample[] = [
  sample01,
  sample02,
  sample03,
  sample04,
  sample05,
  sample06,
  sample07,
  sample08,
  sample09,
  sample10,
  sample11,
  sample12a,
  sample12b,
  sample13,
  sample14,
];

export function findSample(id: string): Sample | undefined {
  return samples.find((s) => s.id === id);
}
