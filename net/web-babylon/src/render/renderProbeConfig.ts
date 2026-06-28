// Parse the client-render probe configuration from URL query params (#167).
//
// The probe is OFF for ordinary interactive play; it turns ON with `?probe=1`.
// Every join key + window knob is overridable so a run's `ClientRenderSample`
// lines can be made to MATCH the join keys of a server bot-ramp `metrics.jsonl`
// stage (scenario / seed / tickRate / botCount / impairment). Defaults mirror
// the `n2-stress-ramp` web stage documented in `net/measurements/n2/README.md`.

import {
  DEFAULT_MAX_WINDOWS,
  DEFAULT_WARMUP_MS,
  DEFAULT_WINDOW_DURATION_MS,
  PROBE_ENGINE,
  type RenderJoinKeys,
} from "./renderProbe";

/** Query-param name that enables the probe (`?probe=1`). */
export const PROBE_ENABLE_PARAM = "probe";

/** Defaults aligned with the documented `n2-stress-ramp` web run. */
export const DEFAULT_SCENARIO = "n2-stress-ramp";
export const DEFAULT_SEED = 12345;
export const DEFAULT_TICK_RATE = 20;
/** A single real browser renderer ⇒ one connected client by default. */
export const DEFAULT_CLIENT_COUNT = 1;
/** Mid ramp stage; override per stage (`2` / `24` / `100`) to sweep load. */
export const DEFAULT_BOT_COUNT = 24;
export const DEFAULT_CLIENT_INDEX = 0;
export const DEFAULT_INJECTED_DELAY_MS = 0;
export const DEFAULT_LOSS_PCT = 0;

/** Fully-resolved probe configuration. */
export interface RenderProbeParams {
  /** Whether the probe should run at all. */
  enabled: boolean;
  /** Settling window excluded before measurement, ms. */
  warmupMs: number;
  /** Fixed wall-clock measurement window length, ms. */
  windowDurationMs: number;
  /** Stop after this many KEPT windows (`null` ⇒ run indefinitely). */
  maxWindows: number | null;
  /** Join keys + per-client identity stamped on every emitted sample. */
  keys: RenderJoinKeys;
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

/** Parse a float query param, falling back to `fallback` on missing/NaN. */
function floatParam(
  params: URLSearchParams,
  name: string,
  fallback: number,
): number {
  const raw = params.get(name);
  if (raw === null) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Build a {@link RenderProbeParams} from a URL query string (e.g.
 * `window.location.search`). PURE — no globals, no DOM — so it unit-tests
 * without a browser.
 *
 * Recognised params (all optional except `probe`):
 *   `probe`               `1` to enable the probe.
 *   `scenario`            join key, e.g. `n2-stress-ramp`.
 *   `seed` `tickRate`     join keys (ints).
 *   `clientCount` `botCount` `clientIndex`   join keys (ints).
 *   `delayCtoSMs` `delayStoCMs` `lossPct`    impairment join keys (numbers).
 *   `warmupMs` `windowDurationMs` `maxWindows`   window framing knobs.
 *
 * The `engine` join key is fixed to `babylon` here (not URL-derived) so a babylon
 * run can never be mislabelled; the three probe (#166) fixes it to `three`.
 */
export function parseRenderProbeParams(search: string): RenderProbeParams {
  const params = new URLSearchParams(search);

  const maxWindowsRaw = params.get("maxWindows");
  const maxWindows =
    maxWindowsRaw === null
      ? DEFAULT_MAX_WINDOWS
      : intParam(params, "maxWindows", DEFAULT_MAX_WINDOWS);

  return {
    enabled: params.get(PROBE_ENABLE_PARAM) === "1",
    warmupMs: intParam(params, "warmupMs", DEFAULT_WARMUP_MS),
    windowDurationMs: intParam(
      params,
      "windowDurationMs",
      DEFAULT_WINDOW_DURATION_MS,
    ),
    // A non-positive maxWindows means "run indefinitely".
    maxWindows: maxWindows > 0 ? maxWindows : null,
    keys: {
      scenario: params.get("scenario") ?? DEFAULT_SCENARIO,
      engine: PROBE_ENGINE,
      seed: intParam(params, "seed", DEFAULT_SEED),
      tickRate: intParam(params, "tickRate", DEFAULT_TICK_RATE),
      clientCount: intParam(params, "clientCount", DEFAULT_CLIENT_COUNT),
      botCount: intParam(params, "botCount", DEFAULT_BOT_COUNT),
      injectedDelayCtoSMs: floatParam(
        params,
        "delayCtoSMs",
        DEFAULT_INJECTED_DELAY_MS,
      ),
      injectedDelayStoCMs: floatParam(
        params,
        "delayStoCMs",
        DEFAULT_INJECTED_DELAY_MS,
      ),
      lossPct: floatParam(params, "lossPct", DEFAULT_LOSS_PCT),
      clientIndex: intParam(params, "clientIndex", DEFAULT_CLIENT_INDEX),
    },
  };
}
