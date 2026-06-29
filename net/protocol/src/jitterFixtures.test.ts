import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { JitterSampler, type JitterConfig } from './jitter.js';
import { createRng } from './rng.js';

// Parity guard (#159): this SHARED fixture keeps the TypeScript `JitterSampler` and
// the Rust port (`net/bevy/src/jitter.rs`) numerically in lockstep — same mulberry32
// seed + same config ⇒ same jitter stream. The sampler is transcendental-free, so the
// match is EXACT (no tolerance needed, like the clientRender fixture). Read via the
// filesystem (the tsconfig enables no JSON loader; `verbatimModuleSyntax` forbids a
// default JSON import).

interface ParityCase {
  name: string;
  seed: number;
  config: JitterConfig;
  count: number;
  expected: number[];
}

const fixturesUrl = new URL('./jitterFixtures.json', import.meta.url);
const fixtures = JSON.parse(readFileSync(fixturesUrl, 'utf8')) as { cases: ParityCase[] };

// Expected values are exact-representable f64 produced by THIS sampler; the epsilon
// documents that the assertion is numeric equality, not approximation.
const EPSILON = 1e-12;

describe('JitterSampler shared parity fixture', () => {
  it('exposes a non-empty case set', () => {
    expect(fixtures.cases.length).toBeGreaterThan(0);
  });

  for (const c of fixtures.cases) {
    it(`reproduces the expected jitter stream: ${c.name}`, () => {
      const sampler = new JitterSampler(c.config, createRng(c.seed));
      const got = Array.from({ length: c.count }, () => sampler.next());
      expect(got.length).toBe(c.expected.length);
      for (let i = 0; i < got.length; i++) {
        expect(Math.abs(got[i] - c.expected[i])).toBeLessThan(EPSILON);
      }
    });
  }
});
