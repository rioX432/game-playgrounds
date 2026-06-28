// mulberry32 PRNG — COPIED (not shared) from net/server/src/sim/rng.ts so this
// subdir stays self-contained per the monorepo CLAUDE.md Core Value #2 (each engine
// subdir self-contained, minimal deps). Kept byte-identical to the net/ chapter so
// measure-mode scatter is methodologically the SAME stream. NOT for cryptography.

/** Create a deterministic PRNG from a 32-bit seed. Returns the next float in [0, 1). */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return (): number => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
