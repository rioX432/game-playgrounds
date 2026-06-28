// Pure, testable scatter for the stress harness (#171). Extracted so determinism
// tests can assert seeded reproducibility without a GPU / physics world.

/** Box drop height (world Y). */
export const SPAWN_HEIGHT = 10;
/** Horizontal/vertical jitter of the spawn cluster. */
export const SPAWN_SPREAD = 4;

export interface SpawnPosition {
  x: number;
  y: number;
  z: number;
}

/**
 * Compute `count` spawn positions, drawing from `rng` in a FIXED order so a given
 * seed reproduces the exact scatter. Draw order (x, y, z) matches the original
 * Math.random() scatter this replaced.
 */
export function computeSpawnPositions(
  count: number,
  rng: () => number,
): SpawnPosition[] {
  const positions: SpawnPosition[] = [];
  for (let i = 0; i < count; i++) {
    const x = (rng() - 0.5) * SPAWN_SPREAD;
    const y = SPAWN_HEIGHT + rng() * SPAWN_SPREAD;
    const z = (rng() - 0.5) * SPAWN_SPREAD;
    positions.push({ x, y, z });
  }
  return positions;
}
