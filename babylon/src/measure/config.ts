// Parse the auto-measure configuration from URL query params (#171, #173).
//
// Measure mode is OFF for ordinary interactive play; it turns ON with `?measure=1`.
// The auto-measure URL contract is:
//   ?sample=13-stress-bodies&bodies=2000&measure=1&seed=N&warmupMs=...&windowMs=...
//   &renderer=webgl|webgpu     (optional; absent = the classic WebGL `Engine` path)
// PURE — no globals, no DOM — so it unit-tests without a browser.

/**
 * Which render backend the measure run drives (#173).
 *  - `"webgl"`  — the classic Babylon `Engine` (WebGL). This IS the PR1 baseline
 *    engine, so the param-absent default maps here and NO re-baseline is needed.
 *  - `"webgpu"` — `WebGPUEngine`.
 *
 * ASYMMETRY vs the three PR (#172): three's `?renderer=webgl` selects
 * `WebGPURenderer`'s WebGL2 *fallback* — a DIFFERENT code path from its PR1
 * classic `WebGLRenderer`, forcing a re-baseline and a `webgpu-webgl2` mode.
 * Babylon has no such split: `Engine` and `WebGPUEngine` are distinct classes
 * from the same `@babylonjs/core` package, so `webgl` here is literally the PR1
 * `Engine` — directly comparable, no `renderer` disambiguator needed.
 */
export type RendererMode = "webgl" | "webgpu";

/** Default number of dynamic bodies spawned in measure mode. */
const DEFAULT_BODIES = 2000;
/** Default RNG seed — shared with the net/ chapter's default for continuity. */
const DEFAULT_SEED = 12345;
/** Default settling window excluded before measurement, ms. */
const DEFAULT_WARMUP_MS = 2000;
/** Default measurement window length, ms. */
const DEFAULT_WINDOW_MS = 4000;
/** Default number of windows captured before the probe stops. */
const DEFAULT_MAX_WINDOWS = 3;

/** Fully-resolved measure configuration. */
export interface MeasureParams {
  /** Whether auto-measure mode should run at all. */
  measure: boolean;
  /** Sample id the run targets (from `?sample=`), e.g. "13-stress-bodies". */
  sample: string;
  /** Body count to spawn in measure mode. */
  bodies: number;
  /** RNG seed for the deterministic scatter. */
  seed: number;
  /** Settling window excluded before measurement, ms. */
  warmupMs: number;
  /** Fixed measurement window length, ms. */
  windowMs: number;
  /** Number of windows to capture before stopping. */
  maxWindows: number;
  /** Which render backend the run drives. Absent/unknown param → `"webgl"`. */
  rendererMode: RendererMode;
}

/** Map the `?renderer=` param value to a {@link RendererMode}. Unknown → webgl. */
function parseRendererMode(raw: string | null): RendererMode {
  // `webgl` and absent both select the classic `Engine` (PR1 baseline); only an
  // explicit `webgpu` opts into `WebGPUEngine`. Unknown values fall back to the
  // safe `webgl` default (never silently pick WebGPU).
  return raw === "webgpu" ? "webgpu" : "webgl";
}

/** Parse an integer query param, falling back to `fallback` on missing/NaN. */
function intParam(
  params: URLSearchParams,
  name: string,
  fallback: number,
): number {
  const raw = params.get(name);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Build {@link MeasureParams} from a URL query string (e.g. `location.search`). */
export function parseMeasureParams(search: string): MeasureParams {
  const params = new URLSearchParams(search);
  return {
    measure: params.get("measure") === "1",
    sample: params.get("sample") ?? "",
    bodies: intParam(params, "bodies", DEFAULT_BODIES),
    seed: intParam(params, "seed", DEFAULT_SEED),
    warmupMs: intParam(params, "warmupMs", DEFAULT_WARMUP_MS),
    windowMs: intParam(params, "windowMs", DEFAULT_WINDOW_MS),
    maxWindows: intParam(params, "maxWindows", DEFAULT_MAX_WINDOWS),
    rendererMode: parseRendererMode(params.get("renderer")),
  };
}
