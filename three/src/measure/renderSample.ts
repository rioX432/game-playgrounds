// Auto-measure frame-time sample (#171) — the STANDALONE three/ playground sidecar.
//
// Deliberately self-contained: this does NOT import net/protocol's ClientRenderSample
// (that schema is locked thin for the networking chapter). The percentile rule and
// the aggregation method mirror net/protocol so numbers stay comparable, but the
// shape here drops every network join key (scenario/tickRate/clientCount/...) and
// carries only what a single-machine render probe needs. Units live in field names
// (`*Ms`, `fps*`), same convention as the net chapter.

import { percentileNearestRank } from "./percentile";

/** Which standalone render engine produced the sample. */
export type RenderEngine = "three" | "babylon";

/**
 * GPU backend the frames were actually drawn on. `"webgl"` is WebGL2 — either the
 * classic `WebGLRenderer` (PR1) OR `WebGPURenderer`'s WebGL2 fallback backend (PR2);
 * the {@link RenderSample.renderer} field disambiguates which.
 */
export type RenderBackend = "webgl" | "webgpu";

/**
 * Which Three renderer family produced the sample. PR1's classic `WebGLRenderer`
 * baseline (`three-webgl-classic`) and PR2's `WebGPURenderer` paths (`three-webgpu`,
 * on either backend) are DIFFERENT code paths and must never be cross-compared as the
 * same "WebGL" number — see docs/web-on-steam/PR0-webgpu-availability.md §re-baseline.
 */
export type RenderRenderer = "three-webgl-classic" | "three-webgpu";

/** One auto-measure window. Emitted as one JSONL line per closed window. */
export interface RenderSample {
  engine: RenderEngine;
  /** Renderer family — distinguishes PR1's classic path from PR2's WebGPURenderer. */
  renderer: RenderRenderer;
  backend: RenderBackend;
  host: "browser";
  /** Number of dynamic bodies in the scene during the window. */
  bodies: number;
  /** RNG seed for the deterministic scatter — makes a run reproducible. */
  seed: number;
  /** Frame time, 50th percentile, ms (nearest-rank over raw deltas). */
  frameTimeP50Ms: number;
  /** Frame time, 95th percentile, ms (nearest-rank over raw deltas). */
  frameTimeP95Ms: number;
  /** Frame time, 99th percentile, ms (nearest-rank over raw deltas). */
  frameTimeP99Ms: number;
  /** Count of frames slower than {@link LONG_FRAME_THRESHOLD_MS} (visible hitches). */
  longFrameCount: number;
  /** Mean delivered fps over the window: frameCount / (sum of deltas in seconds). */
  fpsMean: number;
  /** Sum of the window's frame deltas, ms, rounded — the honest measured span. */
  sampleWindowMs: number;
  /** Number of raw frame deltas the aggregates were computed from. */
  frameCount: number;
}

/** A frame slower than this (ms) is a "long frame" / visible hitch (~20 fps floor). */
export const LONG_FRAME_THRESHOLD_MS = 50;

/** The identity fields a caller stamps onto each sample verbatim. */
export type RenderSampleMeta = Pick<
  RenderSample,
  "engine" | "renderer" | "backend" | "host" | "bodies" | "seed"
>;

/** Milliseconds per second — keep the fps math out of magic numbers. */
const MS_PER_SEC = 1000;
const P50 = 50;
const P95 = 95;
const P99 = 99;

/**
 * Aggregate raw per-frame deltas (ms, capture order, warmup already excluded by the
 * caller) into a {@link RenderSample}. PURE: same inputs → same outputs, no clock
 * reads, so it is unit-testable without a GPU window.
 *
 *  - p50/p95/p99 come DIRECTLY from the sorted raw deltas via one nearest-rank rule
 *    (never a smoothed/EMA value — that would smear the tail).
 *  - `longFrameCount` counts deltas above {@link LONG_FRAME_THRESHOLD_MS}.
 *  - `fpsMean` = frameCount / (sum of deltas in seconds), guarded for empty windows.
 *  - `sampleWindowMs` is the rounded sum of deltas — the actual measured span.
 */
export function aggregateRenderWindow(
  rawDtMs: readonly number[],
  meta: RenderSampleMeta,
): RenderSample {
  const frameCount = rawDtMs.length;
  let sumDt = 0;
  let longFrameCount = 0;
  for (const dt of rawDtMs) {
    sumDt += dt;
    if (dt > LONG_FRAME_THRESHOLD_MS) longFrameCount += 1;
  }

  const sorted = rawDtMs.slice().sort((a, b) => a - b);
  const sumSeconds = sumDt / MS_PER_SEC;
  const fpsMean = sumSeconds > 0 ? frameCount / sumSeconds : 0;

  return {
    ...meta,
    frameTimeP50Ms: percentileNearestRank(sorted, P50),
    frameTimeP95Ms: percentileNearestRank(sorted, P95),
    frameTimeP99Ms: percentileNearestRank(sorted, P99),
    longFrameCount,
    fpsMean,
    sampleWindowMs: Math.round(sumDt),
    frameCount,
  };
}
