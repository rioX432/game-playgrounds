// Networking chapter — wire message contracts (server-authoritative + client interp).
//
// Design rule (Codex-verified, see net/CLAUDE.md): keep these DTOs THIN. The unit
// of cross-engine comparison is the netcode PATTERN, not Colyseus integration
// depth. A fat snapshot degrades the render-engine comparison into a
// "Colyseus-adaptation comparison". Resist adding fields here — every byte on the
// wire must be justified by the mechanic, not by convenience.
//
// The same shapes are emitted by the Colyseus (web) authority today and must be
// mirror-able by the Bevy + bevy_replicon (native) authority later. Nothing here
// may reference a Colyseus-specific type.

/** Position in world space. Tuple, not an object, to keep snapshots compact. */
export type Vec3 = readonly [x: number, y: number, z: number];

/** Planar move axis, each component in [-1, 1]. Tuple for compactness. */
export type MoveAxis = readonly [x: number, z: number];

/**
 * One authoritative player snapshot. THIN by contract:
 * `{ id, pos, yaw, flags, seq }` — nothing else (see module header).
 *
 * - `seq` echoes the last input seq the server processed FOR THIS PLAYER. The
 *   owning client maps it back to its send timestamp to derive RTT without any
 *   cross-machine wall-clock subtraction (see net/CLAUDE.md "RTT is measured
 *   from a client monotonic timestamp echoed back with a seq").
 * - `flags` is a bitfield for boolean entity state (grounded, firing, ...), so
 *   adding a boolean does NOT widen the schema.
 */
export interface PlayerSnapshot {
  /** Stable player/session id. */
  id: string;
  /** Authoritative position. */
  pos: Vec3;
  /** Authoritative facing yaw, radians. */
  yaw: number;
  /** Bitfield of boolean entity state. */
  flags: number;
  /** Last input seq processed for this player (RTT echo). */
  seq: number;
}

/** Bitmasks packed into `PlayerSnapshot.flags` / `PlayerInput.buttons`. */
export const FLAG_GROUNDED = 1 << 0;
export const FLAG_FIRING = 1 << 1;

/**
 * Client → server input for one client tick. Carries the client's monotonic
 * timestamp so RTT is derived from the echoed `seq` round trip, not clock skew.
 */
export interface PlayerInput {
  /** Client-assigned, monotonically increasing per client. Echoed in snapshots. */
  seq: number;
  /** Client monotonic timestamp (ms) when this input was produced. */
  clientTimeMs: number;
  /** Desired planar movement, each axis in [-1, 1]. */
  move: MoveAxis;
  /** Desired facing yaw, radians. */
  yaw: number;
  /** Bitfield of pressed buttons. */
  buttons: number;
}

/** One server → client authoritative snapshot frame for all entities. */
export interface SnapshotMessage {
  /** Server tick index this snapshot was built on. */
  tick: number;
  /** Server monotonic timestamp (ms) when built — client derives snapshot age. */
  serverTimeMs: number;
  /** All replicated players (connected clients + server bots). */
  players: PlayerSnapshot[];
}

/** Server → client one-time handshake after join. */
export interface WelcomeMessage {
  /** Session id assigned to this client; matches its `PlayerSnapshot.id`. */
  playerId: string;
  /** Server simulation tick rate, Hz — drives client interpolation cadence. */
  tickRate: number;
  /** Server monotonic timestamp (ms) at welcome — client clock offset baseline. */
  serverTimeMs: number;
}

/** Message type identifiers shared by both ends of the transport. */
export const MSG = {
  /** client → server: PlayerInput */
  INPUT: 'input',
  /** server → client: SnapshotMessage */
  SNAPSHOT: 'snapshot',
  /** server → client: WelcomeMessage */
  WELCOME: 'welcome',
} as const;

/** Union of valid message type strings. */
export type MessageType = (typeof MSG)[keyof typeof MSG];
