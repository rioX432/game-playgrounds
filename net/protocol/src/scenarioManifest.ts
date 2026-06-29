// Scenario manifest — the SIDECAR that records which WAN profile each scenario
// stage used, WITHOUT widening the locked `MetricsSample` (#140) schema.
//
// WHY A SIDECAR (the thin-schema rule, #159 locked spec): jitter / distribution /
// correlation / reorder are INPUT knobs, not per-tick measurement OUTPUTS — and a
// profile is constant for a whole run, not a per-sample value. Folding them onto
// every `metrics.jsonl` line would (a) fatten the deliberately-thin schema, (b)
// break the #148 diff tooling and the Bevy 18-field pin test. So the profile params
// live in a `scenario-manifest.json` written ALONGSIDE `metrics.jsonl`; readers LEFT
// JOIN on `scenario`. The `metrics.jsonl` row stays byte-for-byte unchanged
// (`injectedDelay*` / `lossPct` already carry the realized base delay + loss; the
// manifest adds the jitter/distribution context those three can't express).
//
// (If a future run truly needs a per-sample jitter value, the locked spec allows ONE
// minimal field `injectedJitterMs = max(up,down)` mirroring `lossPct` — NOT an
// `injectedReorderPct`, since reorder is emergent, not an injected quantity.)

import type { JitterDistribution } from './jitter.js';
import { WAN_PROFILES, type WanProfile, type WanProfileId } from './wanProfiles.js';

/** One manifest entry: the profile + realized knobs for a scenario (the join key). */
export interface ScenarioManifestEntry {
  /** Scenario id — the LEFT JOIN key onto `metrics.jsonl` rows. */
  scenario: string;
  /** WAN profile applied (symmetrically up + down). */
  profile: WanProfileId;
  /** Base one-way delay, ms (matches the emitted `injectedDelay{CtoS,StoC}Ms`). */
  oneWayDelayMs: number;
  /** Jitter magnitude, ms (std-dev-like). */
  jitterSigmaMs: number;
  /** Jitter distribution shape. */
  jitterDistribution: JitterDistribution;
  /** Jitter serial correlation, [0, 1). */
  jitterCorrelation: number;
  /** Loss percent (matches the emitted `lossPct`). */
  lossPct: number;
  /** Honest note on reorder fidelity for THIS stack (set by the writer). */
  reorderNote: string;
}

/** The sidecar file shape: one manifest per scenario run. */
export interface ScenarioManifest {
  /** RNG seed for the run (matches the emitted `seed`). */
  seed: number;
  /** Engine/stack that wrote it (web stacks share a server; bevy is separate). */
  engine: string;
  /** Free-form note (e.g. how to join, what the reorder fidelity means). */
  note: string;
  /** One entry per scenario stage / profile. */
  entries: ScenarioManifestEntry[];
}

/**
 * Default reorder-fidelity note per stack. Web emergent reorder is an
 * APPROXIMATION (reliable ordered channel); Bevy's is faithful (UDP). Kept here so
 * both writers stamp a consistent, honest line.
 */
export const REORDER_NOTE: Record<'web' | 'bevy', string> = {
  web:
    'Reorder emerges from jitter only; APPROXIMATE — Colyseus is a reliable ordered ' +
    'channel (real web transport suppresses reorder via HOL blocking).',
  bevy:
    'Reorder emerges from jitter; faithful — renet runs over UDP (out-of-order ' +
    'delivery is physical).',
};

/** Build a manifest entry from a WAN profile (the realized knobs come from the profile). */
export function manifestEntryFromProfile(
  scenario: string,
  profile: WanProfile,
  reorderNote: string,
): ScenarioManifestEntry {
  return {
    scenario,
    profile: profile.id,
    oneWayDelayMs: profile.oneWayDelayMs,
    jitterSigmaMs: profile.jitter.sigmaMs,
    jitterDistribution: profile.jitter.distribution,
    jitterCorrelation: profile.jitter.correlation,
    lossPct: profile.lossPct,
    reorderNote,
  };
}

/** Convenience: a manifest entry for a profile id (looks up the registry). */
export function manifestEntryForProfileId(
  scenario: string,
  profileId: WanProfileId,
  reorderNote: string,
): ScenarioManifestEntry {
  return manifestEntryFromProfile(scenario, WAN_PROFILES[profileId], reorderNote);
}
