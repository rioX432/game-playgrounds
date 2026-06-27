import { describe, expect, it } from 'vitest';
import { MetricsCollector, type SampleContext } from '../src/metrics/collector.js';

const ctx: Omit<SampleContext, 'clientCount' | 'botCount'> = {
  scenario: 'unit',
  engine: 'three',
  seed: 1,
  tickRate: 20,
  injectedDelayCtoSMs: 0,
  injectedDelayStoCMs: 0,
  lossPct: 0,
};

describe('MetricsCollector', () => {
  it('derives per-second rates over the elapsed window', () => {
    let t = 0;
    const c = new MetricsCollector(() => t);
    c.recordUp(100);
    c.recordUp(100);
    c.recordDown(50);
    t = 1000; // 1 second elapsed

    const s = c.sample({ ...ctx, clientCount: 1, botCount: 0 });

    expect(s.bytesUpPerSec).toBe(200);
    expect(s.bytesDownPerSec).toBe(50);
    // payload (250) + framing (3 msgs * 8) = 274
    expect(s.transportBytesPerSec).toBe(274);
  });

  it('computes nearest-rank RTT percentiles', () => {
    let t = 0;
    const c = new MetricsCollector(() => t);
    for (const v of [40, 10, 30, 20]) c.recordRtt(v);
    t = 1000;

    const s = c.sample({ ...ctx, clientCount: 1, botCount: 0 });

    expect(s.rttP50Ms).toBe(20);
    expect(s.rttP95Ms).toBe(40);
  });

  it('averages per-tick server cost and resets the window', () => {
    let t = 0;
    const c = new MetricsCollector(() => t);
    c.recordTick(2, 1, 0.5);
    c.recordTick(4, 3, 1.5);
    t = 1000;

    const s1 = c.sample({ ...ctx, clientCount: 0, botCount: 2 });
    expect(s1.serverTickSimMs).toBe(3);
    expect(s1.serverTickSerializeMs).toBe(2);
    expect(s1.serverTickSendMs).toBe(1);

    // second window is empty -> zeros, no carryover
    t = 2000;
    const s2 = c.sample({ ...ctx, clientCount: 0, botCount: 2 });
    expect(s2.serverTickSimMs).toBe(0);
    expect(s2.bytesUpPerSec).toBe(0);
    expect(s2.rttP50Ms).toBe(0);
  });
});
