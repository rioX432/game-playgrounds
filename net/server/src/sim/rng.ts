// Deterministic PRNG so a scenario seed reproduces a run. mulberry32: tiny,
// fast, good enough for simulation jitter. NOT for cryptography.
//
// Each consumer gets its OWN stream (see GameRoom): bot motion and transport
// loss draws never share a stream, so bot trajectories stay reproducible
// regardless of async message-arrival timing. (Up-link loss draw ORDER still
// depends on real input arrival, which is inherently non-deterministic; bot
// motion — what drives entity positions and bandwidth — does not.)

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
