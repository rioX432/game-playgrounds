import type { Sample } from "./types";
import { sample01 } from "./01-character-controller/index";
import { sample02 } from "./02-physics-grab-throw/index";
import { sample03 } from "./03-paint-on-mesh/index";

/**
 * The ordered list of all playground samples. `/dev-all` appends a new entry
 * here after implementing the Sample in its own folder under `src/samples/`.
 */
export const samples: Sample[] = [sample01, sample02, sample03];

export function findSample(id: string): Sample | undefined {
  return samples.find((s) => s.id === id);
}
