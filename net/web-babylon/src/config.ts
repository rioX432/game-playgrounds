// Client tunables for the N1 networking sample. No magic numbers in logic —
// everything configurable lives here. The render/input/interpolation knobs are
// deliberately the ONLY client-owned state: authoritative simulation lives on
// the server (see net/CLAUDE.md). These values mirror net/web-three so the two
// clients differ ONLY in rendering/input, never in netcode shape.

/** Colyseus endpoint. Override with VITE_NET_SERVER (e.g. a LAN host). */
export const SERVER_ENDPOINT: string =
  import.meta.env.VITE_NET_SERVER ?? "ws://localhost:2567";

/** Room name registered by the server matchmaker (net/server config.ts). */
export const ROOM_NAME = "game";

/** Input send rate, Hz. Decoupled from render and from the server tick. */
export const INPUT_HZ = 30;

/**
 * Interpolation delay expressed in SERVER TICKS. The client renders this many
 * ticks behind the freshest server time so it always has two snapshots to
 * interpolate between (absorbs jitter + one dropped snapshot). The wall-clock
 * delay is derived from the server's advertised tickRate (WelcomeMessage).
 */
export const INTERP_TICKS = 2;

/** Fallback interpolation delay until the WelcomeMessage tickRate arrives, ms. */
export const DEFAULT_INTERP_DELAY_MS = 100;

/** Max snapshots retained in the interpolation buffer (~a few seconds). */
export const MAX_SNAPSHOTS = 60;

/**
 * Half-extent of the square arena, world units. Cosmetic only here (sizes the
 * ground grid); the authoritative clamp lives in net/server config (ARENA_HALF).
 */
export const ARENA_HALF = 25;

/** Visual radius/height of a rendered player capsule, world units. */
export const PLAYER_RADIUS = 0.5;
export const PLAYER_HEIGHT = 1.6;

// Player body colors as hex strings (Babylon StandardMaterial wants Color3,
// built via Color3.FromHexString in the render layer).
export const COLOR_SELF = "#4fc3f7";
export const COLOR_REMOTE = "#b0bec5";
/** Emissive tint applied while the FLAG_FIRING bit is set (authoritative). */
export const COLOR_FIRING_EMISSIVE = "#ff7043";
/** Facing-indicator nose cone color. */
export const COLOR_NOSE = "#eceff1";
