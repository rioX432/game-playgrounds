import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { n2StressRamp, n2TickrateSweep, n2LatencySweep } from '../src/scenarios/defs.js';
import { runScenario } from '../src/scenarios/runner.js';
import { assertMetricsSample } from '../src/metrics/validate.js';

// Tiny windows so the in-process run stays fast (real numbers come from §8 runs).
const WARMUP_MS = 60;
const MEASURE_MS = 140;

const outPath = (): string => join(tmpdir(), `net-n2-${randomUUID()}.metrics.jsonl`);

const readLines = (path: string): unknown[] =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));

describe('runScenario (#144 N2 load probe)', () => {
  it('n2-stress-ramp emits one schema-valid line per bot stage, bytes scale with sync count', async () => {
    // Arrange
    const metricsPath = outPath();
    const def = n2StressRamp({
      botStages: [2, 8, 16],
      clientCount: 1,
      warmupMs: WARMUP_MS,
      measureMs: MEASURE_MS,
    });

    // Act
    const samples = await runScenario(def, { seed: 42, engine: 'three', metricsPath });

    // Assert: one sample per stage, schema-valid, correct labels
    expect(samples).toHaveLength(3);
    for (const s of samples) {
      assertMetricsSample(s);
      expect(s.scenario).toBe('n2-stress-ramp');
      expect(s.engine).toBe('three');
      expect(s.seed).toBe(42);
      expect(s.tickRate).toBe(20);
      expect(s.clientCount).toBe(1);
      expect(s.lossPct).toBe(0);
    }
    expect(samples.map((s) => s.botCount)).toEqual([2, 8, 16]);

    // Faithful load: more synced entities => bigger snapshots => more downstream bytes.
    expect(samples[2].bytesDownPerSec).toBeGreaterThan(samples[0].bytesDownPerSec);
    // A connected probe measured an RTT round-trip.
    expect(samples[0].rttP50Ms).toBeGreaterThanOrEqual(0);

    // metrics.jsonl mirrors the returned samples, every line schema-conforming.
    const lines = readLines(metricsPath);
    expect(lines).toHaveLength(3);
    for (const line of lines) assertMetricsSample(line);
    expect((lines as { botCount: number }[]).map((l) => l.botCount)).toEqual([2, 8, 16]);
  });

  it('n2-tickrate-sweep boots a fresh room per tick and records each rate', async () => {
    // Arrange
    const metricsPath = outPath();
    const def = n2TickrateSweep({
      ticks: [10, 30],
      botCount: 4,
      clientCount: 1,
      warmupMs: WARMUP_MS,
      measureMs: MEASURE_MS,
    });

    // Act
    const samples = await runScenario(def, { seed: 7, engine: 'babylon', metricsPath });

    // Assert: the tick change took effect (fresh rooms), bots held constant
    expect(samples.map((s) => s.tickRate)).toEqual([10, 30]);
    expect(new Set(samples.map((s) => s.botCount))).toEqual(new Set([4]));
    for (const s of samples) {
      assertMetricsSample(s);
      expect(s.engine).toBe('babylon');
    }
  });

  it('n2-latency-sweep records injected bidirectional delay and lossPct=max(up,down)', async () => {
    // Arrange: an asymmetric impairment point (down worse than up).
    const metricsPath = outPath();
    const def = n2LatencySweep({
      botCount: 4,
      clientCount: 1,
      warmupMs: WARMUP_MS,
      measureMs: MEASURE_MS,
      shimPoints: [
        { up: { delayMs: 0, lossPct: 0 }, down: { delayMs: 0, lossPct: 0 } },
        { up: { delayMs: 20, lossPct: 0 }, down: { delayMs: 40, lossPct: 10 } },
      ],
    });

    // Act
    const samples = await runScenario(def, { seed: 1, engine: 'three', metricsPath });

    // Assert
    expect(samples).toHaveLength(2);
    samples.forEach((s) => assertMetricsSample(s));
    expect(samples[0].injectedDelayCtoSMs).toBe(0);
    expect(samples[1].injectedDelayCtoSMs).toBe(20);
    expect(samples[1].injectedDelayStoCMs).toBe(40);
    // Single-field schema records the WORST link so impairment is never under-reported.
    expect(samples[1].lossPct).toBe(10);
  });
});
