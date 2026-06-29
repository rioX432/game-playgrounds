// `net/protocol` — shared, transport-agnostic types for the networking chapter.
//
// Keep this barrel THIN. Only cross-engine, cross-transport contracts belong
// here. The first contract is the measurement schema (Issue #140); the second is
// the server-authoritative wire protocol (Issue #141).
export { ENGINES } from './metrics.js';
export type { Engine, MetricsSample } from './metrics.js';

// Client-render measurement (sidecar — separate `client-render.jsonl`, NOT a
// `MetricsSample` schema-rev). See `clientRender.ts` for the design rationale.
export {
  aggregateRenderWindow,
  THROTTLE_MAX_MS,
  MIN_VALID_SAMPLES,
} from './clientRender.js';
export type {
  ClientRenderSample,
  MeasurementBasis,
  RenderWindowConfig,
  RenderWindowAggregate,
} from './clientRender.js';

export { FLAG_GROUNDED, FLAG_FIRING, MSG } from './messages.js';
export type {
  Vec3,
  MoveAxis,
  PlayerSnapshot,
  PlayerInput,
  SnapshotMessage,
  WelcomeMessage,
  MessageType,
} from './messages.js';

// Deterministic RNG (shared mulberry32) — used by the jitter sampler + its fixture.
export { createRng } from './rng.js';
export type { Rng } from './rng.js';

// Realistic-transport-condition contracts (#159). The jitter sampler is shared
// (web shim + bevy conditioner); WAN profiles + the scenario-manifest sidecar keep
// the `MetricsSample` schema UNCHANGED (profile params join via `scenario`).
export { JitterSampler, NO_JITTER } from './jitter.js';
export type { JitterConfig, JitterDistribution } from './jitter.js';
export {
  WAN_PROFILES,
  WAN_PROFILE_IDS,
  allWanProfiles,
  wanProfile,
} from './wanProfiles.js';
export type { WanProfile, WanProfileId } from './wanProfiles.js';
export {
  REORDER_NOTE,
  manifestEntryFromProfile,
  manifestEntryForProfileId,
} from './scenarioManifest.js';
export type { ScenarioManifest, ScenarioManifestEntry } from './scenarioManifest.js';
