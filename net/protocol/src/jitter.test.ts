import { describe, expect, it } from 'vitest';
import { JitterSampler, NO_JITTER, type JitterConfig } from './jitter.js';
import { createRng } from './rng.js';

const collect = (config: JitterConfig, seed: number, n: number): number[] => {
  const s = new JitterSampler(config, createRng(seed));
  return Array.from({ length: n }, () => s.next());
};

describe('JitterSampler', () => {
  it('is a no-op for the NO_JITTER config (returns 0, consumes no rng)', () => {
    const rng = createRng(5);
    const s = new JitterSampler(NO_JITTER, rng);
    expect(s.isNoop()).toBe(true);
    for (let i = 0; i < 10; i++) expect(s.next()).toBe(0);
    // rng untouched: a fresh draw equals the first draw of an unused stream.
    expect(rng.next()).toBe(createRng(5).next());
  });

  it('treats sigma <= 0 as a no-op regardless of distribution', () => {
    const s = new JitterSampler({ sigmaMs: 0, distribution: 'normal', correlation: 0 }, createRng(1));
    expect(s.isNoop()).toBe(true);
    expect(s.next()).toBe(0);
  });

  it('is reproducible for a given seed + config', () => {
    const cfg: JitterConfig = { sigmaMs: 8, distribution: 'paretonormal', correlation: 0.3 };
    expect(collect(cfg, 99, 32)).toEqual(collect(cfg, 99, 32));
  });

  it('produces a symmetric (sign-varying) stream for the normal distribution', () => {
    const xs = collect({ sigmaMs: 5, distribution: 'normal', correlation: 0 }, 12345, 200);
    expect(xs.some((x) => x > 0)).toBe(true);
    expect(xs.some((x) => x < 0)).toBe(true);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(Math.abs(mean)).toBeLessThan(1); // ~zero-centered
  });

  it('pareto is one-sided long-tailed: rare large positive spikes, bounded by the cap', () => {
    const sigma = 10;
    const xs = collect({ sigmaMs: sigma, distribution: 'pareto', correlation: 0 }, 42, 500);
    const max = Math.max(...xs);
    const min = Math.min(...xs);
    // Cap = 8, median subtracted = 1 ⇒ max bounded by sigma*(8-1)=70; min by sigma*(0-1)=-10.
    expect(max).toBeLessThanOrEqual(sigma * 7 + 1e-9);
    expect(min).toBeGreaterThanOrEqual(-sigma - 1e-9);
    // It should occasionally spike well above the median.
    expect(max).toBeGreaterThan(sigma);
  });

  it('correlation smooths the stream (lower lag-1 variance of differences)', () => {
    const seed = 2026;
    const indep = collect({ sigmaMs: 6, distribution: 'normal', correlation: 0 }, seed, 400);
    const corr = collect({ sigmaMs: 6, distribution: 'normal', correlation: 0.8 }, seed, 400);
    const stepVar = (xs: number[]): number => {
      const diffs = xs.slice(1).map((x, i) => x - xs[i]);
      const m = diffs.reduce((a, b) => a + b, 0) / diffs.length;
      return diffs.reduce((a, b) => a + (b - m) ** 2, 0) / diffs.length;
    };
    // Strong correlation ⇒ neighbouring samples are closer ⇒ smaller step variance.
    expect(stepVar(corr)).toBeLessThan(stepVar(indep));
  });
});
