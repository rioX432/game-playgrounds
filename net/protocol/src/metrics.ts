// Networking chapter — measurement schema.
//
// This file LOCKS the measurement contract for the entire `net/` chapter before
// any N1/N2 sample is built. One `MetricsSample` == one line of `metrics.jsonl`.
// Every engine (three / babylon / bevy) emits the SAME shape so cross-engine
// comparison stays apples-to-apples.
//
// Design rule (Codex-verified): keep this THIN. Do not add per-engine or
// per-transport fields here — a fat schema turns the render-engine comparison
// into a Colyseus-adaptation comparison. New axes need an explicit schema-rev.

/**
 * Engines under comparison. Single source of truth for the `Engine` union.
 */
export const ENGINES = ['three', 'babylon', 'bevy'] as const;

/**
 * Render/runtime engine a sample was measured on.
 */
export type Engine = (typeof ENGINES)[number];

/**
 * One measurement point in a networking scenario run.
 *
 * Serialized one-per-line into `metrics.jsonl` (see `net/CLAUDE.md`). Field
 * units are encoded in the names (`*Ms`, `*PerSec`, `*Pct`) — keep that
 * convention for every future field so the schema reads without a legend.
 */
export interface MetricsSample {
  /** Scenario id, e.g. "n2-stress-ramp". Groups samples across a run. */
  scenario: string;
  /** Engine the sample was measured on. */
  engine: Engine;
  /** RNG seed for the run — makes a scenario reproducible. */
  seed: number;
  /** Server simulation tick rate, in Hz. */
  tickRate: number;
  /** Number of connected clients at sample time. */
  clientCount: number;
  /** Number of server-driven bots at sample time. */
  botCount: number;

  /** Application payload sent client→server, bytes/sec. */
  bytesUpPerSec: number;
  /** Application payload sent server→client, bytes/sec. */
  bytesDownPerSec: number;
  /** Estimated on-the-wire bytes/sec incl. transport/framing overhead. */
  transportBytesPerSec: number;

  /** Round-trip time, 50th percentile, ms (client monotonic ts + echoed seq). */
  rttP50Ms: number;
  /** Round-trip time, 95th percentile, ms. */
  rttP95Ms: number;
  /** Age of the snapshot being interpolated/rendered, ms (interp buffer depth). */
  snapshotAgeMs: number;

  /** Per server tick: simulation cost, ms. */
  serverTickSimMs: number;
  /** Per server tick: state serialization cost, ms. */
  serverTickSerializeMs: number;
  /** Per server tick: send/flush cost, ms. */
  serverTickSendMs: number;

  /** Injected one-way delay, client→server, ms (network-condition knob). */
  injectedDelayCtoSMs: number;
  /** Injected one-way delay, server→client, ms. */
  injectedDelayStoCMs: number;
  /** Injected packet loss, percent [0..100]. */
  lossPct: number;
}
