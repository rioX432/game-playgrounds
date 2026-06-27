// N2 load-probe scenario model (#144).
//
// A scenario is an ordered list of measurement STAGES. Each stage pins the
// room-construction params (tickRate, shim, clientCount) plus the live-rampable
// botCount, and the timing of its measurement window. The runner emits exactly
// one MetricsSample line per stage. See `runner.ts` for how stages are grouped
// into room boots (a fresh room is required whenever tickRate/shim/clientCount
// changes, since those are fixed at onCreate).

import type { ShimConfig } from '../transport/shim.js';

/** One measurement point: room params + bot load + window timing. */
export interface Stage {
  /** Server-driven bot count (the sync-entity load). Live-ramped within a segment. */
  botCount: number;
  /** Connected probe clients (RTT / snapshot-age sources). */
  clientCount: number;
  /** Server tick rate, Hz (clamped to the 10–30 band by the room). */
  tickRate: number;
  /** Bidirectional impairment for this stage. */
  shim: ShimConfig;
  /**
   * Settle time after applying this stage's botCount BEFORE the measured
   * window opens. Discarded so the sample is not polluted by ramp transients.
   */
  warmupMs: number;
  /** Length of the measured window whose averages become the sample. */
  measureMs: number;
}

/** A named, ordered set of stages. */
export interface ScenarioDef {
  /** Scenario id, stamped on every emitted MetricsSample (e.g. "n2-stress-ramp"). */
  id: string;
  /** Honest-feel notes / caveats for interpreting this scenario's samples. */
  notes: string;
  /** The stages, run in order. */
  stages: Stage[];
}
