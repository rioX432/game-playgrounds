import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { aggregateRenderWindow } from './clientRender.js';

// Parity guard (#168): this SHARED fixture is the single source of truth that keeps
// the TypeScript `aggregateRenderWindow` and the Rust `aggregate_render_window`
// (net/bevy/src/client_render.rs) numerically in lockstep. Both read THIS json and
// assert the same expected aggregates. Read via the filesystem because the package
// tsconfig enables neither `resolveJsonModule` nor a JSON loader (and
// `verbatimModuleSyntax` forbids a default JSON import).

interface ParityCase {
  name: string;
  rawDtMs: number[];
  windowDurationMs: number;
  dropFirstFrame: boolean;
  expected: {
    clientFps: number;
    clientFrameTimeP50Ms: number;
    clientFrameTimeP95Ms: number;
    sampleCount: number;
    throttled: boolean;
    valid: boolean;
  };
}

const fixturesUrl = new URL('./clientRenderFixtures.json', import.meta.url);
const fixtures = JSON.parse(readFileSync(fixturesUrl, 'utf8')) as { cases: ParityCase[] };

// Expected values are exact-representable f64; a tiny epsilon documents that the
// assertion is a numeric-equality check, not an approximate one.
const EPSILON = 1e-9;

describe('aggregateRenderWindow shared parity fixture', () => {
  it('exposes a non-empty case set', () => {
    expect(fixtures.cases.length).toBeGreaterThan(0);
  });

  for (const c of fixtures.cases) {
    it(`matches expected aggregates: ${c.name}`, () => {
      const out = aggregateRenderWindow(c.rawDtMs, {
        windowDurationMs: c.windowDurationMs,
        dropFirstFrame: c.dropFirstFrame,
      });

      expect(Math.abs(out.clientFps - c.expected.clientFps)).toBeLessThan(EPSILON);
      expect(Math.abs(out.clientFrameTimeP50Ms - c.expected.clientFrameTimeP50Ms)).toBeLessThan(EPSILON);
      expect(Math.abs(out.clientFrameTimeP95Ms - c.expected.clientFrameTimeP95Ms)).toBeLessThan(EPSILON);
      expect(out.sampleCount).toBe(c.expected.sampleCount);
      expect(out.throttled).toBe(c.expected.throttled);
      expect(out.valid).toBe(c.expected.valid);
    });
  }
});
