// Cross-engine delay-JITTER sampler — the shared contract for #159 (realistic
// transport conditions). The web `TransportShim` and the Bevy `Conditioner` both
// add a per-delivery jitter offset drawn from THIS sampler, so a scenario seed
// produces the same jitter stream on both stacks.
//
// PARITY IS THE POINT. The math is deliberately TRANSCENDENTAL-FREE (no log / cos
// / pow) so the TypeScript sampler here and the Rust port (`net/bevy/src/jitter.rs`)
// agree BIT-FOR-BIT given the same mulberry32 draws — exactly like the
// `aggregateRenderWindow` precedent (#168). A checked-in fixture
// (`jitterFixtures.json`) pins them numerically identical.
//
// These are netem-MENU-aligned APPROXIMATIONS, not the exact netem distribution
// tables: `normal` via Irwin–Hall (sum of uniforms), the long tail via a clamped
// Lomax transform. netem offers uniform/normal/pareto/paretonormal
// (https://man7.org/linux/man-pages/man8/tc-netem.8.html); we mirror the SHAPES
// reproducibly. Modeling choices (the tail cap, the 50/50 blend) are constants
// below, documented, not hidden.

import type { Rng } from './rng.js';

/**
 * Jitter distribution shape. Mirrors the netem menu names; the math is our
 * transcendental-free approximation (see file header).
 *  - `none`          — no jitter (fast path; consumes NO rng draws).
 *  - `normal`        — symmetric, ≈ N(0, sigma) via Irwin–Hall. Delay can dip or rise.
 *  - `pareto`        — one-sided long tail (clamped Lomax). Occasional positive spikes.
 *  - `paretonormal`  — 50/50 blend: a symmetric core plus a positive long tail.
 */
export type JitterDistribution = 'none' | 'normal' | 'pareto' | 'paretonormal';

/** Per-direction jitter knobs (added to a link's base one-way delay). */
export interface JitterConfig {
  /**
   * Jitter magnitude in ms (std-dev-like scale). `<= 0` means no jitter
   * regardless of `distribution` (fast path: consumes no rng).
   */
  sigmaMs: number;
  /** Distribution shape. */
  distribution: JitterDistribution;
  /**
   * Serial correlation with the previous sample, in `[0, 1)`:
   * `out = correlation * prev + (1 - correlation) * fresh`. netem's correlation%
   * knob. 0 = independent draws; higher = smoother, more bursty wander.
   */
  correlation: number;
}

/** A clean (jitter-free) config. */
export const NO_JITTER: JitterConfig = {
  sigmaMs: 0,
  distribution: 'none',
  correlation: 0,
};

/** Uniforms summed for the Irwin–Hall normal approximation (`sum(12 u) - 6` ≈ N(0,1)). */
const IRWIN_HALL_N = 12;
/** Half of `IRWIN_HALL_N` — the mean to subtract so the result is zero-centered. */
const IRWIN_HALL_MEAN = IRWIN_HALL_N / 2;
/**
 * Clamp on the Lomax tail unit so a single near-1 draw can't produce an absurd
 * spike. `u/(1-u)` is the α=1 Lomax (heavy-tailed); capping bounds the worst
 * single-sample spike to `sigma * (PARETO_TAIL_CAP - 1)`.
 */
const PARETO_TAIL_CAP = 8;
/** Lomax median (at u=0.5, `u/(1-u)=1`); subtracted so `pareto` is ~zero-centered. */
const PARETO_MEDIAN = 1;

/** One standardized (pre-sigma) draw for a distribution. Pure arithmetic. */
function standardDraw(distribution: JitterDistribution, rng: Rng): number {
  switch (distribution) {
    case 'none':
      return 0;
    case 'normal':
      return irwinHall(rng);
    case 'pareto':
      return lomax(rng);
    case 'paretonormal':
      // Symmetric core + positive long tail, equally weighted.
      return 0.5 * irwinHall(rng) + 0.5 * lomax(rng);
    default: {
      // Exhaustive — keeps the switch honest if a variant is added.
      const _never: never = distribution;
      return _never;
    }
  }
}

/** Irwin–Hall standard-normal approximation: sum of N uniforms minus the mean. */
function irwinHall(rng: Rng): number {
  let sum = 0;
  for (let i = 0; i < IRWIN_HALL_N; i++) sum += rng.next();
  return sum - IRWIN_HALL_MEAN;
}

/** Clamped, median-centered α=1 Lomax: a one-sided long tail. */
function lomax(rng: Rng): number {
  const u = rng.next();
  // u/(1-u) blows up as u→1; cap it, then center on the median so the mean offset
  // is ~0 and the distribution only adds OCCASIONAL positive spikes.
  const tail = Math.min(u / (1 - u), PARETO_TAIL_CAP);
  return tail - PARETO_MEDIAN;
}

/**
 * Stateful per-link jitter sampler. Call {@link next} once per delivery to get a
 * signed jitter offset in ms; the caller adds it to the base one-way delay and
 * clamps the result at 0 (a link can't deliver before "now").
 *
 * Holds the previous output for the correlation recurrence. Reproducible: same
 * seed + same config ⇒ same sequence (the parity guarantee).
 */
export class JitterSampler {
  private prev = 0;

  constructor(
    private readonly config: JitterConfig,
    private readonly rng: Rng,
  ) {}

  /** True if this sampler always returns 0 and consumes no rng. */
  isNoop(): boolean {
    return this.config.sigmaMs <= 0 || this.config.distribution === 'none';
  }

  /** Next signed jitter offset, ms (may be negative for symmetric distributions). */
  next(): number {
    if (this.isNoop()) return 0;
    const fresh = this.config.sigmaMs * standardDraw(this.config.distribution, this.rng);
    const c = this.config.correlation;
    const out = c * this.prev + (1 - c) * fresh;
    this.prev = out;
    return out;
  }
}
