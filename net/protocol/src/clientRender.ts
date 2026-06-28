// Networking chapter — CLIENT-RENDER measurement contract (sidecar).
//
// Design (Codex-verified): this is a SIDECAR, not a schema-rev of `MetricsSample`.
// Client render performance (fps + frame-time) is written to its OWN JSONL file
// (`client-render.jsonl`), one line per measurement window, and the server-side
// `MetricsSample` (`metrics.ts`) stays THIN and untouched.
//
// Why a sidecar and not extra columns on `MetricsSample`:
//   - Web fps is sampled from `requestAnimationFrame` deltas; Bevy fps comes from
//     frame-time diagnostics. That is a §8.2 PARITY GAP (see COMPARISON.md): the two
//     are observed differently and are NOT a directly-comparable "client truth".
//   - Folding render fields onto every server `metrics.jsonl` line would falsely
//     imply such a comparable client truth exists on each server tick. It does not.
//   - Render perf is per-REAL-client, while a server line aggregates all clients;
//     the cardinalities differ, so they belong in separate files.
//
// The sample carries the same JOIN KEYS as `MetricsSample` (scenario / engine /
// seed / tickRate / clientCount / botCount + the impairment knobs) so a tool can
// LEFT JOIN `client-render.jsonl` onto `metrics.jsonl` without pretending one IS
// the other. Units live in field names (`*Ms`, `fps`) — same convention as metrics.ts.

import type { Engine } from './metrics.js';

/**
 * How a window's frame deltas were observed. Kept as an explicit union because the
 * web (`requestAnimationFrame` dt) and Bevy (frame-time diagnostics) paths are a
 * documented parity gap, not interchangeable measurements.
 */
export type MeasurementBasis = 'web-raf-dt' | 'bevy-frame-diagnostics';

/**
 * One client-render measurement window. Serialized one-per-line into
 * `client-render.jsonl` (append-only JSON Lines, same convention as `metrics.jsonl`).
 *
 * Join keys mirror `MetricsSample` field names/semantics exactly so lines align
 * with the server `metrics.jsonl` of the same run.
 */
export interface ClientRenderSample {
  // --- Join keys (identical semantics to MetricsSample) ---
  /** Scenario id, e.g. "n2-stress-ramp". Groups samples across a run. */
  scenario: string;
  /** Render/runtime engine this client ran on. */
  engine: Engine;
  /** RNG seed for the run — makes a scenario reproducible. */
  seed: number;
  /** Server simulation tick rate, in Hz. */
  tickRate: number;
  /** Number of connected clients during the window. */
  clientCount: number;
  /** Number of server-driven bots during the window. */
  botCount: number;
  /** Injected one-way delay, client→server, ms (network-condition knob). */
  injectedDelayCtoSMs: number;
  /** Injected one-way delay, server→client, ms. */
  injectedDelayStoCMs: number;
  /** Injected packet loss, percent [0..100]. */
  lossPct: number;

  // --- Per-real-client identity ---
  /** Which real (human-driving) client this render sample belongs to. Render perf
   *  is per-client, unlike the server-aggregated `MetricsSample`. 0-based. */
  clientIndex: number;

  // --- Window framing ---
  /** Client monotonic timestamp at window start, ms (warmup excluded by caller). */
  windowStartMs: number;
  /** Wall-clock duration the window accumulated frame deltas over, ms. This is the
   *  denominator for `clientFps` — NOT the sum of frame deltas. */
  windowDurationMs: number;

  // --- Measured render performance ---
  /** Delivered frames per second over the window: validFrameCount / window seconds. */
  clientFps: number;
  /** Frame time, 50th percentile, ms (nearest-rank over raw deltas). */
  clientFrameTimeP50Ms: number;
  /** Frame time, 95th percentile, ms (nearest-rank over raw deltas). */
  clientFrameTimeP95Ms: number;
  /** Count of valid frame deltas the aggregates were computed from. Low ⇒ weak. */
  sampleCount: number;

  /** How the deltas were observed (web rAF vs Bevy diagnostics). */
  measurementBasis: MeasurementBasis;
}

// --- Shared sampler ------------------------------------------------------------
//
// A PURE function over raw frame deltas, decoupled from any render loop. The caller
// (web rAF loop / Bevy frame diagnostics) collects `dtMs` over a wall-clock window,
// keeps warmup OUT of that window, then hands the deltas here for aggregation. No
// `Date.now`/`performance.now` is read inside this function, so it is deterministic
// and unit-testable without a GPU window.

/**
 * A frame delta above this (ms) is treated as a tab-throttle / suspend artifact
 * (backgrounded tab, OS sleep), not a real foreground stutter. Such a delta is
 * excluded from the aggregates AND flags the whole window `throttled` so the caller
 * can drop it. Chosen well above ordinary 40–100 ms "under load" foreground spikes —
 * those are legitimate and MUST survive into p95. 250 ms ≈ a tab clamped to ~4 fps.
 */
export const THROTTLE_MAX_MS = 250;

/**
 * Minimum valid frame deltas for a window to be considered statistically usable.
 * Below this, nearest-rank p95 degenerates toward the raw max and fps is noisy, so
 * the window is marked invalid. ~0.5 s of 60 fps data; a heuristic floor, not a law.
 */
export const MIN_VALID_SAMPLES = 30;

/** Percent for the p50 (median) frame-time aggregate. */
const P50 = 50;
/** Percent for the p95 frame-time aggregate. */
const P95 = 95;

/** Milliseconds per second — keep fps math out of magic numbers. */
const MS_PER_SEC = 1000;

/**
 * Knobs for {@link aggregateRenderWindow}. The caller owns timing; this struct only
 * carries values the pure function cannot derive from the deltas themselves.
 */
export interface RenderWindowConfig {
  /** Real wall-clock duration the caller accumulated `dtMs` over, ms. Denominator
   *  for `clientFps`. Must be > 0 for a valid window. */
  windowDurationMs: number;
  /** Drop the FIRST delta after start/resume (setup / stale-timestamp artifact).
   *  Defaults to true; set false only when the caller already trimmed it. */
  dropFirstFrame?: boolean;
}

/**
 * The render-performance subset of {@link ClientRenderSample} this sampler computes,
 * plus validity signals. The caller merges these into a full `ClientRenderSample`
 * with the join keys and window framing.
 */
export interface RenderWindowAggregate {
  /** Delivered frames per second: validFrameCount / (windowDurationMs / 1000). */
  clientFps: number;
  /** Frame time, 50th percentile, ms (nearest-rank). */
  clientFrameTimeP50Ms: number;
  /** Frame time, 95th percentile, ms (nearest-rank). */
  clientFrameTimeP95Ms: number;
  /** Count of valid deltas used (after first-frame drop and throttle exclusion). */
  sampleCount: number;
  /** True if any delta exceeded {@link THROTTLE_MAX_MS}; the caller SHOULD drop a
   *  throttled window rather than record a background pause as foreground perf. */
  throttled: boolean;
  /** False when the window is throttled OR has fewer than {@link MIN_VALID_SAMPLES}
   *  valid deltas. A false here means the recorded metrics are weak — discard. */
  valid: boolean;
}

/**
 * Nearest-rank percentile over an ascending-sorted array. One rule, kept IDENTICAL
 * across engines so web and Bevy percentiles are comparable. For `n` values the
 * p-th percentile is the value at 1-based rank `ceil(p/100 * n)`.
 * Precondition: `sortedAsc` is non-empty and sorted ascending.
 */
function percentileNearestRank(sortedAsc: readonly number[], p: number): number {
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  // Clamp into [1, n] to guard against floating-point edge cases at p=0/100.
  const index = Math.min(Math.max(rank, 1), sortedAsc.length) - 1;
  return sortedAsc[index];
}

const EMPTY_AGGREGATE: RenderWindowAggregate = {
  clientFps: 0,
  clientFrameTimeP50Ms: 0,
  clientFrameTimeP95Ms: 0,
  sampleCount: 0,
  throttled: false,
  valid: false,
};

/**
 * Aggregate raw frame deltas into client-render metrics. PURE: same inputs → same
 * outputs, no clock reads.
 *
 * Rules (Codex-verified, kept identical across engines):
 *  - Drop the FIRST delta after start/resume (setup / stale-timestamp artifact).
 *  - fps = validFrameCount / (windowDurationMs / 1000) — observed delivered frames
 *    over the REAL wall-clock window, NOT `1000 / avgDt`.
 *  - Percentiles come DIRECTLY from the raw sorted deltas via one nearest-rank rule.
 *    Never feed a HUD fps-EMA in here — that would smear the p95 tail.
 *  - A delta above {@link THROTTLE_MAX_MS} is a tab-throttle/suspend artifact:
 *    excluded from the aggregates and flags `throttled`. Ordinary 40–100 ms
 *    foreground spikes stay in and rightly inflate p95.
 *  - `valid` is false when throttled or under {@link MIN_VALID_SAMPLES}.
 *
 * @param rawDtMs Frame deltas in ms, in capture order. Warmup must already be
 *   excluded by the caller (the window starts AFTER warmup).
 * @param config Window duration + first-frame-drop policy.
 */
export function aggregateRenderWindow(
  rawDtMs: readonly number[],
  config: RenderWindowConfig,
): RenderWindowAggregate {
  const dropFirst = config.dropFirstFrame ?? true;

  // 1. Drop the first delta after start/resume.
  const afterDrop =
    dropFirst && rawDtMs.length > 0 ? rawDtMs.slice(1) : rawDtMs.slice();

  // 2. Detect throttle artifacts and split them out (excluded from aggregates so a
  //    single background pause cannot dominate p95). Their presence still flags the
  //    window throttled so the caller can drop it.
  let throttled = false;
  const valid: number[] = [];
  for (const dt of afterDrop) {
    if (dt > THROTTLE_MAX_MS) {
      throttled = true;
      continue;
    }
    valid.push(dt);
  }

  if (valid.length === 0 || config.windowDurationMs <= 0) {
    return { ...EMPTY_AGGREGATE, throttled };
  }

  // 3. fps over the REAL wall-clock window (not the sum of deltas).
  const windowSeconds = config.windowDurationMs / MS_PER_SEC;
  const clientFps = valid.length / windowSeconds;

  // 4. Percentiles directly from sorted raw deltas (foreground spikes preserved).
  const sorted = valid.slice().sort((a, b) => a - b);
  const clientFrameTimeP50Ms = percentileNearestRank(sorted, P50);
  const clientFrameTimeP95Ms = percentileNearestRank(sorted, P95);

  const sampleCount = valid.length;
  const isValid = !throttled && sampleCount >= MIN_VALID_SAMPLES;

  return {
    clientFps,
    clientFrameTimeP50Ms,
    clientFrameTimeP95Ms,
    sampleCount,
    throttled,
    valid: isValid,
  };
}
