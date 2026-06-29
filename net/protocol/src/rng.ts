// Deterministic PRNG (mulberry32) — the SHARED canonical definition for the net/
// chapter. A scenario seed reproduces a run; tiny, fast, NOT cryptographic.
//
// This is the same algorithm already ported in `net/server/src/sim/rng.ts` and
// `net/bevy/src/rng.rs` (Rust). It lives here too so the cross-engine jitter
// sampler (`jitter.ts`) and its parity fixture are self-contained in the shared
// layer. Bit-for-bit identical across all three so a seed yields the same draw
// stream everywhere.

export interface Rng {
  /** Next float in [0, 1). */
  next(): number;
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
  return { next };
}
