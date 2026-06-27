// Deterministic PRNG so a scenario seed fully reproduces a run (bot motion,
// packet-loss draws). mulberry32: tiny, fast, good enough for simulation jitter.
// NOT for cryptography.

export interface Rng {
  /** Next float in [0, 1). */
  next(): number;
  /** Next float in [min, max). */
  range(min: number, max: number): number;
}

/** Create a deterministic RNG from a 32-bit seed. */
export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (min, max) => min + next() * (max - min),
  };
}
