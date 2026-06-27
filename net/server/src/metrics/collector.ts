// Aggregates raw measurements over a window and emits one MetricsSample (the
// LOCKED #140 schema — imported, never redefined). Server-tick timings + byte
// counters come from the room; RTT + snapshot-age come from the probe clients.

import type { Engine, MetricsSample } from 'net-protocol';
import { FRAMING_OVERHEAD_BYTES } from '../config.js';

/** Static context that labels a sample (not measured, supplied by the scenario). */
export interface SampleContext {
  scenario: string;
  engine: Engine;
  seed: number;
  tickRate: number;
  clientCount: number;
  botCount: number;
  injectedDelayCtoSMs: number;
  injectedDelayStoCMs: number;
  /**
   * Injected loss recorded in the (thin) single-field schema. The shim supports
   * asymmetric up/down loss; the caller records `max(up, down)` so impairment is
   * never under-reported. Splitting this into two fields is a deliberate
   * schema-rev, out of scope here (see net/CLAUDE.md).
   */
  lossPct: number;
}

const MIN_ELAPSED_SEC = 1e-3;

/** Nearest-rank percentile of an ascending-sorted array; 0 if empty. */
function percentile(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  const rank = Math.ceil((p / 100) * n);
  const idx = Math.min(Math.max(rank - 1, 0), n - 1);
  return sortedAsc[idx];
}

const mean = (xs: number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

/** Accumulates raw signals; `sample()` reduces+resets the window. */
export class MetricsCollector {
  private upBytes = 0;
  private downBytes = 0;
  private upMsgs = 0;
  private downMsgs = 0;
  private simMs: number[] = [];
  private serializeMs: number[] = [];
  private sendMs: number[] = [];
  private rttMs: number[] = [];
  private snapshotAgeMs: number[] = [];
  private windowStart: number;

  constructor(private readonly now: () => number = () => performance.now()) {
    this.windowStart = this.now();
  }

  /** Offered application bytes, client->server (one input message). */
  recordUp(bytes: number): void {
    this.upBytes += bytes;
    this.upMsgs += 1;
  }

  /** Offered application bytes, server->client (one snapshot to one client). */
  recordDown(bytes: number): void {
    this.downBytes += bytes;
    this.downMsgs += 1;
  }

  /** Per-tick server cost breakdown, ms. */
  recordTick(simMs: number, serializeMs: number, sendMs: number): void {
    this.simMs.push(simMs);
    this.serializeMs.push(serializeMs);
    this.sendMs.push(sendMs);
  }

  /** A probe client's measured round-trip time, ms. */
  recordRtt(ms: number): void {
    this.rttMs.push(ms);
  }

  /** A probe client's measured snapshot age at receipt, ms. */
  recordSnapshotAge(ms: number): void {
    this.snapshotAgeMs.push(ms);
  }

  /** Reduce the current window into one MetricsSample and reset counters. */
  sample(ctx: SampleContext): MetricsSample {
    const elapsedSec = Math.max(
      (this.now() - this.windowStart) / 1000,
      MIN_ELAPSED_SEC,
    );
    const overhead = (this.upMsgs + this.downMsgs) * FRAMING_OVERHEAD_BYTES;
    const rttSorted = [...this.rttMs].sort((a, b) => a - b);

    const out: MetricsSample = {
      scenario: ctx.scenario,
      engine: ctx.engine,
      seed: ctx.seed,
      tickRate: ctx.tickRate,
      clientCount: ctx.clientCount,
      botCount: ctx.botCount,
      bytesUpPerSec: this.upBytes / elapsedSec,
      bytesDownPerSec: this.downBytes / elapsedSec,
      transportBytesPerSec:
        (this.upBytes + this.downBytes + overhead) / elapsedSec,
      rttP50Ms: percentile(rttSorted, 50),
      rttP95Ms: percentile(rttSorted, 95),
      snapshotAgeMs: mean(this.snapshotAgeMs),
      serverTickSimMs: mean(this.simMs),
      serverTickSerializeMs: mean(this.serializeMs),
      serverTickSendMs: mean(this.sendMs),
      injectedDelayCtoSMs: ctx.injectedDelayCtoSMs,
      injectedDelayStoCMs: ctx.injectedDelayStoCMs,
      lossPct: ctx.lossPct,
    };
    this.reset();
    return out;
  }

  /**
   * Discard the current window WITHOUT emitting a sample. Used to drop a
   * post-ramp warmup window so the next sample's averages are not polluted by
   * the previous stage's bot count or the partial connect/ramp window (#144).
   */
  resetWindow(): void {
    this.reset();
  }

  private reset(): void {
    this.upBytes = 0;
    this.downBytes = 0;
    this.upMsgs = 0;
    this.downMsgs = 0;
    this.simMs = [];
    this.serializeMs = [];
    this.sendMs = [];
    this.rttMs = [];
    this.snapshotAgeMs = [];
    this.windowStart = this.now();
  }
}
