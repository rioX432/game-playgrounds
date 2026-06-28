// Client-render measurement probe (#167) — the Babylon.js consumer of the shared
// #165 sidecar contract (`net-protocol` → `aggregateRenderWindow`). Mirrors the
// three.js probe (#166) one-for-one; the ONLY engine-specific delta is
// `PROBE_ENGINE = "babylon"` (and the raw dt source in `main.ts`).
//
// Responsibilities, kept deliberately small and render-loop-free so they
// unit-test headless:
//   - batch RAW per-frame `dtMs` into fixed wall-clock windows (warmup excluded);
//   - hand each closed window to the SHARED pure sampler `aggregateRenderWindow`;
//   - drop throttled / statistically-weak windows;
//   - stamp the join keys and emit one `ClientRenderSample` per kept window.
//
// What this module must NEVER do (Codex note baked into #165):
//   - feed Babylon's smoothed `engine.getFps()` EMA into the sampler — only raw
//     `dtMs` go in (that EMA is the babylon analogue of three's HUD fps-EMA trap);
//   - read a clock itself — the caller (the render loop) supplies `nowMs`, so the
//     batching logic stays deterministic and testable without a GPU window.

import {
  aggregateRenderWindow,
  type ClientRenderSample,
  type Engine,
} from "net-protocol";

/** This probe runs inside the Babylon.js client; its samples are always `babylon`. */
export const PROBE_ENGINE: Engine = "babylon";

/**
 * Default settling window, ms, excluded before measurement begins (counted from
 * the moment the client is marked ready — connected AND first snapshot in). It
 * covers shader compilation, scene setup and first-snapshot interpolation
 * warmup so those one-off costs never pollute the steady-state render numbers.
 */
export const DEFAULT_WARMUP_MS = 2000;

/**
 * Default measurement window length, ms. At 60 fps this is ~300 raw deltas —
 * an order of magnitude above the contract's `MIN_VALID_SAMPLES` floor, so a
 * kept window is statistically solid even under load.
 */
export const DEFAULT_WINDOW_DURATION_MS = 5000;

/** Default number of KEPT windows to capture before the probe stops. */
export const DEFAULT_MAX_WINDOWS = 3;

/**
 * The join keys + per-client identity a `ClientRenderSample` carries verbatim.
 * Identical semantics to the server `MetricsSample` so a tool can LEFT JOIN the
 * two JSONL files. The render-performance fields are computed by the sampler;
 * everything here is supplied by the caller from the run's parameters.
 */
export type RenderJoinKeys = Pick<
  ClientRenderSample,
  | "scenario"
  | "engine"
  | "seed"
  | "tickRate"
  | "clientCount"
  | "botCount"
  | "injectedDelayCtoSMs"
  | "injectedDelayStoCMs"
  | "lossPct"
  | "clientIndex"
>;

/** Window framing the caller owns (the sampler cannot derive these from deltas). */
export interface RenderWindowFraming {
  /** Client monotonic timestamp at window start, ms. */
  windowStartMs: number;
  /** Wall-clock duration the window accumulated deltas over, ms. fps denominator. */
  windowDurationMs: number;
  /**
   * Whether to drop the first delta. The probe keeps windows CONTIGUOUS after
   * warmup, so there is no stale-timestamp/resume artifact at a boundary — it
   * passes `false`. Defaults to the shared sampler's own policy when omitted.
   */
  dropFirstFrame?: boolean;
}

/**
 * PURE window → sample builder. Runs the raw deltas through the shared sampler
 * and, if the window is usable, merges the aggregates with the join keys into a
 * full `ClientRenderSample`. Returns `null` for a throttled or invalid window so
 * the caller drops it (never records a background pause as foreground perf).
 *
 * No clock reads, no render loop — same inputs always produce the same output,
 * which is exactly the part #167 unit-tests headless.
 */
export function buildClientRenderSample(
  rawDtMs: readonly number[],
  framing: RenderWindowFraming,
  keys: RenderJoinKeys,
): ClientRenderSample | null {
  const aggregate = aggregateRenderWindow(rawDtMs, {
    windowDurationMs: framing.windowDurationMs,
    dropFirstFrame: framing.dropFirstFrame,
  });

  // Contract rule: drop the window unless it is both un-throttled AND valid.
  if (aggregate.throttled || !aggregate.valid) {
    return null;
  }

  return {
    ...keys,
    windowStartMs: framing.windowStartMs,
    windowDurationMs: framing.windowDurationMs,
    clientFps: aggregate.clientFps,
    clientFrameTimeP50Ms: aggregate.clientFrameTimeP50Ms,
    clientFrameTimeP95Ms: aggregate.clientFrameTimeP95Ms,
    sampleCount: aggregate.sampleCount,
    // Web path always observes deltas via the rAF-driven render loop (#165 parity gap).
    measurementBasis: "web-raf-dt",
  };
}

/** A consumer of emitted samples (push to a global array, console.log, etc.). */
export type RenderSampleSink = (sample: ClientRenderSample) => void;

/** Construction-time knobs for {@link RenderProbe}. */
export interface RenderProbeOptions {
  /** Join keys stamped on every emitted sample (from the run's parameters). */
  keys: RenderJoinKeys;
  /** Where kept samples are delivered. */
  sink: RenderSampleSink;
  /** Settling window excluded before measurement, ms. */
  warmupMs?: number;
  /** Fixed wall-clock window length, ms. */
  windowDurationMs?: number;
  /** Stop after this many KEPT windows. `null` ⇒ run indefinitely. */
  maxWindows?: number | null;
}

/**
 * Stateful batching glue between the render loop and the pure sampler. The caller
 * pushes raw per-frame timestamps via {@link recordFrame}; the probe computes raw
 * per-frame deltas, excludes warmup, closes fixed wall-clock windows, and emits
 * a `ClientRenderSample` per kept window. It is render-loop-free (the caller
 * supplies the timestamp), so it is fully unit-testable without a browser.
 */
export class RenderProbe {
  private readonly keys: RenderJoinKeys;
  private readonly sink: RenderSampleSink;
  private readonly warmupMs: number;
  private readonly windowDurationMs: number;
  private readonly maxWindows: number | null;

  private lastFrameMs: number | null = null;
  private readyAtMs: number | null = null;
  private windowStartMs: number | null = null;
  private buffer: number[] = [];
  private kept = 0;

  constructor(options: RenderProbeOptions) {
    this.keys = options.keys;
    this.sink = options.sink;
    this.warmupMs = options.warmupMs ?? DEFAULT_WARMUP_MS;
    this.windowDurationMs = options.windowDurationMs ?? DEFAULT_WINDOW_DURATION_MS;
    this.maxWindows = options.maxWindows ?? DEFAULT_MAX_WINDOWS;
  }

  /**
   * Mark the client ready to measure (connected AND first snapshot received).
   * Starts the warmup countdown; idempotent — only the FIRST call matters.
   */
  markReady(nowMs: number): void {
    if (this.readyAtMs === null) {
      this.readyAtMs = nowMs;
    }
  }

  /** Number of KEPT (emitted) windows so far. */
  get windowCount(): number {
    return this.kept;
  }

  /** True once the configured KEPT-window target is reached. */
  get done(): boolean {
    return this.maxWindows !== null && this.kept >= this.maxWindows;
  }

  /**
   * Feed one render-loop timestamp. Computes the raw delta from the previous
   * frame, skips warmup, accumulates into the live window, and closes it when the
   * wall-clock duration elapses.
   */
  recordFrame(nowMs: number): void {
    const prevFrameMs = this.lastFrameMs;
    this.lastFrameMs = nowMs;

    // Not connected / no first snapshot yet — nothing to measure.
    if (this.readyAtMs === null) return;
    // Inside the warmup window — excluded by design.
    if (nowMs - this.readyAtMs < this.warmupMs) return;
    // Target reached — stop accumulating.
    if (this.done) return;

    // Open the first window exactly at the warmup boundary. The boundary frame
    // itself contributes no delta, so the first accumulated delta is a clean
    // post-warmup foreground frame.
    if (this.windowStartMs === null) {
      this.windowStartMs = nowMs;
      return;
    }

    // Raw per-frame delta — NEVER a smoothed/EMA value (#165 contract).
    if (prevFrameMs !== null) {
      this.buffer.push(nowMs - prevFrameMs);
    }

    if (nowMs - this.windowStartMs >= this.windowDurationMs) {
      this.closeWindow(nowMs);
    }
  }

  /** Aggregate the live window, emit if kept, then start the next one. */
  private closeWindow(nowMs: number): void {
    const windowStartMs = this.windowStartMs ?? nowMs;
    // Honest denominator: the ACTUAL wall-clock the deltas spanned, not the
    // configured target (a window closes on the first frame past the target).
    const actualDurationMs = nowMs - windowStartMs;

    const sample = buildClientRenderSample(
      this.buffer,
      {
        windowStartMs,
        windowDurationMs: actualDurationMs,
        // Contiguous windows post-warmup ⇒ no boundary artifact to drop.
        dropFirstFrame: false,
      },
      this.keys,
    );

    if (sample !== null) {
      this.sink(sample);
      this.kept += 1;
    }

    // Start the next window contiguously at this frame.
    this.windowStartMs = nowMs;
    this.buffer = [];
  }
}
