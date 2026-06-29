// Named N2 load-probe scenarios (#144) — the verification of "what does the web
// netcode cost under load" for the performance chapter. Each builder returns a
// data-only ScenarioDef; the runner executes it. Builders take an options bag so
// tests can shrink the run (tiny windows / fewer stages) without forking the
// definition.

import { allWanProfiles, type WanProfile } from 'net-protocol';
import type { ShimConfig } from '../transport/shim.js';
import type { ScenarioDef, Stage } from './types.js';

/** Default settle window before a stage is measured, ms. */
const DEFAULT_WARMUP_MS = 500;
/** Default measured window per stage, ms. */
const DEFAULT_MEASURE_MS = 1500;
/** Default probe clients (the RTT/snapshot-age sources; load comes from bots). */
const DEFAULT_CLIENTS = 2;
/** Default tick rate for fixed-tick scenarios, Hz. */
const DEFAULT_TICK = 20;
/** Default fixed bot count for the sweep scenarios. */
const DEFAULT_FIXED_BOTS = 24;
/** Default bot count for the adhoc run (matches the #141 single-stage default). */
const ADHOC_DEFAULT_BOTS = 8;

/** The sync-entity ramp: 2 → 100 server bots (single fresh, live-ramped room). */
const DEFAULT_BOT_STAGES = [2, 8, 16, 24, 50, 100] as const;
/** Tick rates probed for the cost/freshness optimum (within the 10–30 band). */
const DEFAULT_TICKS = [10, 15, 20, 30] as const;

const noShim = (): ShimConfig => ({
  up: { delayMs: 0, lossPct: 0 },
  down: { delayMs: 0, lossPct: 0 },
});

/** Symmetric bidirectional impairment (same delay+loss up and down). */
const sym = (delayMs: number, lossPct: number): ShimConfig => ({
  up: { delayMs, lossPct },
  down: { delayMs, lossPct },
});

/**
 * Translate a shared WAN profile (#159) into a symmetric ShimConfig — same base
 * delay, jitter, and loss applied up AND down. The jitter config rides along on
 * each `LinkConfig`, so the shim's `JitterSampler` reproduces the profile's stream.
 */
export const profileToShim = (p: WanProfile): ShimConfig => ({
  up: { delayMs: p.oneWayDelayMs, lossPct: p.lossPct, jitter: p.jitter },
  down: { delayMs: p.oneWayDelayMs, lossPct: p.lossPct, jitter: p.jitter },
});

/** Default bidirectional sweep: clean → delay ramp → delay+loss. */
const DEFAULT_SHIM_POINTS: readonly ShimConfig[] = [
  sym(0, 0),
  sym(25, 0),
  sym(50, 0),
  sym(100, 0),
  sym(50, 5),
  sym(50, 10),
];

/** Common knobs every builder understands; unused fields are simply ignored. */
export interface ScenarioOpts {
  clientCount?: number;
  tickRate?: number;
  botCount?: number;
  botStages?: readonly number[];
  ticks?: readonly number[];
  shimPoints?: readonly ShimConfig[];
  /** Single shim for the adhoc scenario. */
  shim?: ShimConfig;
  warmupMs?: number;
  measureMs?: number;
}

interface Timing {
  warmupMs: number;
  measureMs: number;
}

const timing = (o: ScenarioOpts): Timing => ({
  warmupMs: o.warmupMs ?? DEFAULT_WARMUP_MS,
  measureMs: o.measureMs ?? DEFAULT_MEASURE_MS,
});

/**
 * `n2-stress-ramp`: ramp the synchronized-entity count at a FIXED tick and zero
 * impairment. All stages share room params, so the runner uses ONE room and
 * live-ramps the bots — the faithful "load grows under a steady server" shape.
 */
export function n2StressRamp(o: ScenarioOpts = {}): ScenarioDef {
  const t = timing(o);
  const stages: Stage[] = (o.botStages ?? DEFAULT_BOT_STAGES).map((botCount) => ({
    botCount,
    clientCount: o.clientCount ?? DEFAULT_CLIENTS,
    tickRate: o.tickRate ?? DEFAULT_TICK,
    shim: noShim(),
    warmupMs: t.warmupMs,
    measureMs: t.measureMs,
  }));
  return {
    id: 'n2-stress-ramp',
    notes:
      'Sync-entity ramp at fixed tick / zero impairment. Single room, live bot ramp. ' +
      'bytesDownPerSec and serverTickSerializeMs scale with botCount; serverTickSendMs is valid (zero down-delay).',
    stages,
  };
}

/**
 * `n2-latency-sweep`: hold bots fixed and sweep the bidirectional shim. Each
 * point has a different shim, so the runner boots a FRESH room per stage.
 */
export function n2LatencySweep(o: ScenarioOpts = {}): ScenarioDef {
  const t = timing(o);
  const stages: Stage[] = (o.shimPoints ?? DEFAULT_SHIM_POINTS).map((shim) => ({
    botCount: o.botCount ?? DEFAULT_FIXED_BOTS,
    clientCount: o.clientCount ?? DEFAULT_CLIENTS,
    tickRate: o.tickRate ?? DEFAULT_TICK,
    shim,
    warmupMs: t.warmupMs,
    measureMs: t.measureMs,
  }));
  return {
    id: 'n2-latency-sweep',
    notes:
      'Bidirectional shim sweep at fixed bots/tick. lossPct is recorded as max(up,down). ' +
      'CAVEAT: serverTickSendMs is NOT comparable across stages with down.delayMs>0 (the shim ' +
      'defers the real send); compare only sim/serialize and RTT/snapshotAge there.',
    stages,
  };
}

/**
 * `n2-tickrate-sweep`: hold bots fixed and sweep the tick rate to find the
 * cost/freshness optimum. tickRate is fixed at onCreate, so each rate is a
 * FRESH room.
 */
export function n2TickrateSweep(o: ScenarioOpts = {}): ScenarioDef {
  const t = timing(o);
  const stages: Stage[] = (o.ticks ?? DEFAULT_TICKS).map((tickRate) => ({
    botCount: o.botCount ?? DEFAULT_FIXED_BOTS,
    clientCount: o.clientCount ?? DEFAULT_CLIENTS,
    tickRate,
    shim: noShim(),
    warmupMs: t.warmupMs,
    measureMs: t.measureMs,
  }));
  return {
    id: 'n2-tickrate-sweep',
    notes:
      'Tick-rate sweep at fixed bots / zero impairment. Higher tick = fresher snapshots ' +
      '(lower snapshotAge) but more serverTick + downlink bytes/sec. Each rate is a fresh room.',
    stages,
  };
}

/**
 * `n2-wan-profile-sweep` (#159): hold bots/tick fixed and sweep the named WAN
 * profiles (clean → good-wifi → 4g-mobile → transcontinental). Each profile has a
 * distinct delay/loss (and jitter), so the runner boots a FRESH room per stage.
 * The realized jitter/distribution/correlation per stage is recorded in the
 * `scenario-manifest.json` sidecar (the thin `MetricsSample` is unchanged); join
 * a metrics line to its profile on `scenario` + `injectedDelay*` + `lossPct`.
 */
export function n2WanProfileSweep(o: ScenarioOpts = {}): ScenarioDef {
  const t = timing(o);
  const stages: Stage[] = allWanProfiles().map((profile) => ({
    botCount: o.botCount ?? DEFAULT_FIXED_BOTS,
    clientCount: o.clientCount ?? DEFAULT_CLIENTS,
    tickRate: o.tickRate ?? DEFAULT_TICK,
    shim: profileToShim(profile),
    warmupMs: t.warmupMs,
    measureMs: t.measureMs,
  }));
  return {
    id: 'n2-wan-profile-sweep',
    notes:
      'Named WAN-profile sweep at fixed bots/tick (clean→good-wifi→4g-mobile→transcontinental). ' +
      'Fresh room per profile. lossPct recorded as max(up,down); base delay in injectedDelay*; ' +
      'jitter/distribution/correlation are in scenario-manifest.json (join on scenario+delay+loss). ' +
      'Reorder is emergent from jitter and only APPROXIMATE on web (reliable ordered channel). ' +
      'serverTickSendMs is NOT comparable across stages with down-delay>0 (the shim defers the send).',
    stages,
  };
}

/**
 * `adhoc`: a single-shim bot ramp driven entirely by the caller's options —
 * the env-configured run preserved from #141 (BOTS / TICK / DELAY / LOSS knobs).
 * One room, live bot ramp.
 */
export function adhoc(o: ScenarioOpts = {}): ScenarioDef {
  const t = timing(o);
  const shim = o.shim ?? noShim();
  const stages: Stage[] = (o.botStages ?? [o.botCount ?? ADHOC_DEFAULT_BOTS]).map(
    (botCount) => ({
      botCount,
      clientCount: o.clientCount ?? DEFAULT_CLIENTS,
      tickRate: o.tickRate ?? DEFAULT_TICK,
      shim,
      warmupMs: t.warmupMs,
      measureMs: t.measureMs,
    }),
  );
  return {
    id: 'adhoc',
    notes: 'Caller-configured single-shim bot ramp (env-driven). One room, live bot ramp.',
    stages,
  };
}

/** Scenario registry keyed by id — single source of truth for the CLI + tests. */
export const SCENARIOS: Record<string, (o?: ScenarioOpts) => ScenarioDef> = {
  'n2-stress-ramp': n2StressRamp,
  'n2-latency-sweep': n2LatencySweep,
  'n2-tickrate-sweep': n2TickrateSweep,
  'n2-wan-profile-sweep': n2WanProfileSweep,
  adhoc,
};

/** Known scenario ids (for CLI help / validation). */
export const scenarioIds = (): string[] => Object.keys(SCENARIOS);
