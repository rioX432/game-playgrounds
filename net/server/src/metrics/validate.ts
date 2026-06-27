// Runtime validator for the LOCKED #140 MetricsSample schema. Lives in the
// server (the first emitter); can be promoted to net/protocol if a second
// emitter needs it. Asserts every field is present with the right type so a
// metrics.jsonl line is provably schema-conforming.

import { ENGINES, type Engine, type MetricsSample } from 'net-protocol';

/** The 16 numeric fields of MetricsSample (the 18 total minus scenario/engine). */
const NUMERIC_FIELDS = [
  'seed',
  'tickRate',
  'clientCount',
  'botCount',
  'bytesUpPerSec',
  'bytesDownPerSec',
  'transportBytesPerSec',
  'rttP50Ms',
  'rttP95Ms',
  'snapshotAgeMs',
  'serverTickSimMs',
  'serverTickSerializeMs',
  'serverTickSendMs',
  'injectedDelayCtoSMs',
  'injectedDelayStoCMs',
  'lossPct',
] as const satisfies ReadonlyArray<keyof MetricsSample>;

const isEngine = (v: unknown): v is Engine =>
  typeof v === 'string' && (ENGINES as readonly string[]).includes(v);

/** Type guard: true iff `v` is a fully-formed, finite-valued MetricsSample. */
export function isMetricsSample(v: unknown): v is MetricsSample {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.scenario !== 'string' || o.scenario.length === 0) return false;
  if (!isEngine(o.engine)) return false;
  for (const key of NUMERIC_FIELDS) {
    const n = o[key];
    if (typeof n !== 'number' || !Number.isFinite(n)) return false;
  }
  // No extra fields: the schema is thin on purpose.
  const allowed = new Set<string>(['scenario', 'engine', ...NUMERIC_FIELDS]);
  for (const key of Object.keys(o)) {
    if (!allowed.has(key)) return false;
  }
  return true;
}

/** Throwing variant for tests/tooling; returns the value narrowed. */
export function assertMetricsSample(v: unknown): MetricsSample {
  if (!isMetricsSample(v)) {
    throw new Error(
      `Object does not conform to MetricsSample (#140) schema: ${JSON.stringify(v)}`,
    );
  }
  return v;
}
