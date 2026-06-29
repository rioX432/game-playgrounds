// Named WAN profiles — the shared, transport-agnostic transport-condition presets
// for #159. Each profile bundles a base one-way delay, a jitter config, and a loss
// rate; the web `TransportShim` and the Bevy `Conditioner` both translate a profile
// into their own per-direction link config, so "4g-mobile" means the same impairment
// on both stacks.
//
// PARITY / HONESTY notes baked in:
// - Injection is SYMMETRIC up/down (one profile → both directions) — matches the
//   existing `sym(...)` shim points; asymmetric routes are out of scope for #159.
// - REORDER has no field on purpose. Packet reordering EMERGES from jitter (a later
//   sample can get a smaller delay and overtake an earlier one); netem itself says
//   reordering requires variable delay. On the web side this emergent reorder is an
//   APPROXIMATION (Colyseus is a reliable ordered channel — real web transport would
//   suppress it via HOL blocking); on the Bevy side (UDP) it is faithful. Documented,
//   not faked (Core Value #1). See `net/CLAUDE.md` / COMPARISON §8.
// - These are localhost-injected presets, NOT a WAN benchmark. Grounding sources are
//   in each profile's `notes`.

import type { JitterConfig } from './jitter.js';

/** Profile ids. `clean` is the zero-injection control. */
export const WAN_PROFILE_IDS = [
  'clean',
  'good-wifi',
  '4g-mobile',
  'transcontinental',
] as const;

export type WanProfileId = (typeof WAN_PROFILE_IDS)[number];

/** A named transport-condition preset (applied symmetrically up + down). */
export interface WanProfile {
  /** Stable id (also the scenario-stage label). */
  id: WanProfileId;
  /** Human-readable label. */
  label: string;
  /** Base one-way delay, ms (RTT ≈ 2× this). */
  oneWayDelayMs: number;
  /** Jitter added on top of the base delay, per delivery. */
  jitter: JitterConfig;
  /** Packet loss, percent in [0, 100]. */
  lossPct: number;
  /** Grounding sources + honest-feel note for interpreting this profile. */
  notes: string;
}

/**
 * The profile registry. Numbers are grounded in the #159 research memo's cited
 * sources (good-/poor-network thresholds, 5G/LTE latency studies, transatlantic
 * RTT + tier-1 SLAs) — directional presets, not a measured WAN.
 */
export const WAN_PROFILES: Record<WanProfileId, WanProfile> = {
  clean: {
    id: 'clean',
    label: 'Clean (localhost control)',
    oneWayDelayMs: 0,
    jitter: { sigmaMs: 0, distribution: 'none', correlation: 0 },
    lossPct: 0,
    notes:
      'Zero-injection control — the existing localhost baseline. Isolates the ' +
      'profile sweep from the machine/transport floor.',
  },
  'good-wifi': {
    id: 'good-wifi',
    label: 'Good Wi-Fi / LAN',
    oneWayDelayMs: 10,
    jitter: { sigmaMs: 3, distribution: 'normal', correlation: 0.25 },
    lossPct: 0.1,
    notes:
      '~20 ms RTT, small symmetric ±3 ms jitter (normal), 0.1% loss. LAN/good-Wi-Fi ' +
      'is low and symmetric, so a normal distribution fits. Grounding: UC good/poor ' +
      'thresholds (Tom Talks UC, OnSIP).',
  },
  '4g-mobile': {
    id: '4g-mobile',
    label: '4G / LTE mobile',
    oneWayDelayMs: 25,
    jitter: { sigmaMs: 10, distribution: 'pareto', correlation: 0.25 },
    lossPct: 1.0,
    notes:
      '~50 ms RTT, ±10 ms long-tailed jitter (pareto — cellular scheduling spikes), ' +
      '1% loss. The long tail models occasional radio-scheduling latency bursts. ' +
      'Grounding: R&S 5G/LTE latency analysis.',
  },
  transcontinental: {
    id: 'transcontinental',
    label: 'Transcontinental / transatlantic',
    oneWayDelayMs: 80,
    jitter: { sigmaMs: 20, distribution: 'paretonormal', correlation: 0.5 },
    lossPct: 0.5,
    notes:
      '~160 ms RTT, ±20 ms jitter (paretonormal — stable core + path-change long ' +
      'tail), 0.5% loss, higher correlation (long-haul wander). Grounding: ' +
      'transatlantic RTT (Broadcast Bridge) + tier-1 SLA (NTT-GIN).',
  },
};

/** All profiles in registry order (clean first). */
export function allWanProfiles(): WanProfile[] {
  return WAN_PROFILE_IDS.map((id) => WAN_PROFILES[id]);
}

/** Look up a profile by id, or `undefined` if unknown. */
export function wanProfile(id: string): WanProfile | undefined {
  return (WAN_PROFILES as Record<string, WanProfile>)[id];
}
