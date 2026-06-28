// Standalone render probe (#171) — mirrors the SEMANTICS of net/web-three's
// RenderProbe, minus all network coupling. It batches raw per-frame deltas into
// fixed wall-clock windows (warmup excluded), hands each closed window to the pure
// `aggregateRenderWindow`, and emits one RenderSample per window via `onSample`.
//
// It is clock-free (the caller supplies `nowMs`), so the batching logic is fully
// deterministic and unit-testable without a browser/GPU.

import {
  aggregateRenderWindow,
  type RenderSample,
  type RenderSampleMeta,
} from "./renderSample";

/** Construction-time knobs for {@link RenderProbe}. */
export interface RenderProbeOptions {
  /** Settling window excluded before measurement begins, ms. */
  warmupMs: number;
  /** Fixed wall-clock window length, ms. */
  windowMs: number;
  /** Stop after this many emitted windows. */
  maxWindows: number;
  /** Identity stamped on every emitted sample. */
  meta: RenderSampleMeta;
  /** Where each closed window's sample is delivered. */
  onSample: (sample: RenderSample) => void;
}

/**
 * Stateful glue between the render loop and the pure sampler. The caller pushes
 * frame timestamps via {@link recordFrame}; the probe computes raw deltas, drops
 * warmup frames, closes fixed wall-clock windows, and emits a sample per window.
 */
export class RenderProbe {
  private readonly warmupMs: number;
  private readonly windowMs: number;
  private readonly maxWindows: number;
  private readonly meta: RenderSampleMeta;
  private readonly onSample: (sample: RenderSample) => void;

  private startedAtMs: number | null = null;
  private lastFrameMs: number | null = null;
  private windowStartMs: number | null = null;
  private buffer: number[] = [];
  private completed = 0;
  private finished = false;

  constructor(options: RenderProbeOptions) {
    this.warmupMs = options.warmupMs;
    this.windowMs = options.windowMs;
    this.maxWindows = options.maxWindows;
    this.meta = options.meta;
    this.onSample = options.onSample;
  }

  /** Start the warmup countdown. Idempotent — only the first call matters. */
  markStart(nowMs: number): void {
    if (this.startedAtMs === null) this.startedAtMs = nowMs;
  }

  /** True once the configured number of windows has been emitted. */
  isDone(): boolean {
    return this.finished;
  }

  /**
   * Feed one frame timestamp. Computes the delta from the previous frame, skips
   * warmup, accumulates into the live window, and closes it once the wall-clock
   * duration elapses.
   */
  recordFrame(nowMs: number): void {
    if (this.finished || this.startedAtMs === null) return;

    const prevFrameMs = this.lastFrameMs;
    this.lastFrameMs = nowMs;

    // Inside the warmup window — discarded by design.
    if (nowMs - this.startedAtMs < this.warmupMs) return;

    // Open the first window exactly at the warmup boundary. The boundary frame
    // contributes no delta, so the first accumulated delta is a clean post-warmup
    // foreground frame.
    if (this.windowStartMs === null) {
      this.windowStartMs = nowMs;
      return;
    }

    // Raw per-frame delta — NEVER a smoothed/EMA value.
    if (prevFrameMs !== null) this.buffer.push(nowMs - prevFrameMs);

    if (nowMs - this.windowStartMs >= this.windowMs) this.closeWindow(nowMs);
  }

  /** Aggregate the live window, emit it, then start the next one contiguously. */
  private closeWindow(nowMs: number): void {
    this.onSample(aggregateRenderWindow(this.buffer, this.meta));
    this.completed += 1;
    this.buffer = [];
    this.windowStartMs = nowMs;
    if (this.completed >= this.maxWindows) this.finished = true;
  }
}
