import { describe, expect, it } from 'vitest';
import {
  aggregateRenderWindow,
  MIN_VALID_SAMPLES,
  THROTTLE_MAX_MS,
} from './clientRender.js';

/** Build a constant series of `count` deltas of `dtMs` each. */
function constantDeltas(count: number, dtMs: number): number[] {
  return Array.from({ length: count }, () => dtMs);
}

describe('aggregateRenderWindow', () => {
  it('marks an empty series invalid with zeroed aggregates', () => {
    const out = aggregateRenderWindow([], { windowDurationMs: 1000 });

    expect(out.valid).toBe(false);
    expect(out.sampleCount).toBe(0);
    expect(out.clientFps).toBe(0);
    expect(out.clientFrameTimeP50Ms).toBe(0);
    expect(out.clientFrameTimeP95Ms).toBe(0);
  });

  it('marks a window with too few samples invalid even when aggregates compute', () => {
    // One under MIN_VALID_SAMPLES *after* the dropped first frame.
    const deltas = constantDeltas(MIN_VALID_SAMPLES, 16);

    const out = aggregateRenderWindow(deltas, { windowDurationMs: 1000 });

    expect(out.sampleCount).toBe(MIN_VALID_SAMPLES - 1);
    expect(out.valid).toBe(false);
  });

  it('marks a window valid once it has at least MIN_VALID_SAMPLES after the drop', () => {
    const deltas = constantDeltas(MIN_VALID_SAMPLES + 1, 16);

    const out = aggregateRenderWindow(deltas, { windowDurationMs: 1000 });

    expect(out.sampleCount).toBe(MIN_VALID_SAMPLES);
    expect(out.valid).toBe(true);
  });

  it('drops the first frame delta by default', () => {
    // Huge first delta would wreck p95 if it were kept; it must be dropped.
    const deltas = [10_000, ...constantDeltas(MIN_VALID_SAMPLES, 16)];

    const out = aggregateRenderWindow(deltas, { windowDurationMs: 1000 });

    expect(out.sampleCount).toBe(MIN_VALID_SAMPLES);
    expect(out.clientFrameTimeP95Ms).toBe(16);
    expect(out.throttled).toBe(false);
  });

  it('keeps the first frame delta when dropFirstFrame is false', () => {
    const deltas = constantDeltas(MIN_VALID_SAMPLES + 1, 16);

    const out = aggregateRenderWindow(deltas, {
      windowDurationMs: 1000,
      dropFirstFrame: false,
    });

    expect(out.sampleCount).toBe(MIN_VALID_SAMPLES + 1);
  });

  it('computes nearest-rank percentiles on a known series', () => {
    // 100 distinct values 1..100 after the dropped first frame.
    const series = [0, ...Array.from({ length: 100 }, (_, i) => i + 1)];

    const out = aggregateRenderWindow(series, {
      windowDurationMs: 1000,
    });

    // Nearest-rank: p50 -> rank ceil(0.50*100)=50 -> value 50; p95 -> rank 95 -> 95.
    expect(out.sampleCount).toBe(100);
    expect(out.clientFrameTimeP50Ms).toBe(50);
    expect(out.clientFrameTimeP95Ms).toBe(95);
  });

  it('computes fps as delivered frames over the real wall-clock window, not 1000/avgDt', () => {
    // 120 valid 16ms deltas across a 2s window => 60 fps. 1000/16 would be 62.5.
    const deltas = [16, ...constantDeltas(120, 16)];

    const out = aggregateRenderWindow(deltas, { windowDurationMs: 2000 });

    expect(out.sampleCount).toBe(120);
    expect(out.clientFps).toBeCloseTo(60, 6);
    expect(out.clientFps).not.toBeCloseTo(1000 / 16, 6);
  });

  it('flags a throttled window and excludes the suspend delta from p95', () => {
    // One background pause well above the throttle threshold among normal frames.
    const deltas = [
      16,
      ...constantDeltas(MIN_VALID_SAMPLES, 16),
      THROTTLE_MAX_MS + 500,
    ];

    const out = aggregateRenderWindow(deltas, { windowDurationMs: 1000 });

    expect(out.throttled).toBe(true);
    expect(out.valid).toBe(false); // throttled windows are never valid
    // The 750ms pause is excluded, so p95 stays at the foreground frame time.
    expect(out.clientFrameTimeP95Ms).toBe(16);
    expect(out.sampleCount).toBe(MIN_VALID_SAMPLES);
  });

  it('keeps ordinary under-load foreground spikes in p95', () => {
    // A burst of legitimate 40-100ms spikes must survive into the p95 tail.
    const base = constantDeltas(90, 16);
    const spikes = constantDeltas(10, 80); // 10% of frames at 80ms
    const deltas = [0, ...base, ...spikes];

    const out = aggregateRenderWindow(deltas, { windowDurationMs: 1000 });

    expect(out.throttled).toBe(false);
    // p95 -> rank ceil(0.95*100)=95 -> falls inside the 80ms spike band.
    expect(out.clientFrameTimeP95Ms).toBe(80);
    expect(out.clientFrameTimeP50Ms).toBe(16);
  });

  it('treats a non-positive window duration as invalid', () => {
    const deltas = constantDeltas(MIN_VALID_SAMPLES + 1, 16);

    const out = aggregateRenderWindow(deltas, { windowDurationMs: 0 });

    expect(out.valid).toBe(false);
    expect(out.clientFps).toBe(0);
  });

  it('is pure: repeated calls on the same input return equal results', () => {
    const deltas = constantDeltas(MIN_VALID_SAMPLES + 5, 16);
    const cfg = { windowDurationMs: 1000 };

    expect(aggregateRenderWindow(deltas, cfg)).toEqual(
      aggregateRenderWindow(deltas, cfg),
    );
  });
});
