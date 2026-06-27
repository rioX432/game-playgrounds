import { describe, expect, it } from 'vitest';
import type { MetricsSample } from 'net-protocol';
import { isMetricsSample } from '../src/metrics/validate.js';

const valid: MetricsSample = {
  scenario: 'unit',
  engine: 'three',
  seed: 1,
  tickRate: 20,
  clientCount: 1,
  botCount: 8,
  bytesUpPerSec: 100,
  bytesDownPerSec: 200,
  transportBytesPerSec: 320,
  rttP50Ms: 12,
  rttP95Ms: 30,
  snapshotAgeMs: 50,
  serverTickSimMs: 1,
  serverTickSerializeMs: 0.5,
  serverTickSendMs: 0.2,
  injectedDelayCtoSMs: 0,
  injectedDelayStoCMs: 0,
  lossPct: 0,
};

describe('isMetricsSample', () => {
  it('accepts a fully-formed sample', () => {
    expect(isMetricsSample(valid)).toBe(true);
  });

  it('rejects a missing numeric field', () => {
    const { rttP95Ms, ...partial } = valid;
    void rttP95Ms;
    expect(isMetricsSample(partial)).toBe(false);
  });

  it('rejects a non-finite numeric field', () => {
    expect(isMetricsSample({ ...valid, snapshotAgeMs: NaN })).toBe(false);
  });

  it('rejects an unknown engine', () => {
    expect(isMetricsSample({ ...valid, engine: 'unreal' })).toBe(false);
  });

  it('rejects extra fields (schema is thin on purpose)', () => {
    expect(isMetricsSample({ ...valid, extra: 1 })).toBe(false);
  });
});
