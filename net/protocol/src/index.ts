// `net/protocol` — shared, transport-agnostic types for the networking chapter.
//
// Keep this barrel THIN. Only cross-engine, cross-transport contracts belong
// here. The first contract is the measurement schema (Issue #140); the second is
// the server-authoritative wire protocol (Issue #141).
export { ENGINES } from './metrics.js';
export type { Engine, MetricsSample } from './metrics.js';

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
