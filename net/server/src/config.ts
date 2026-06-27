// Server tunables. No magic numbers in logic — everything configurable lives here.
//
// The chapter measures *patterns*, not a specific game, so these defaults are
// deliberately plain. The optimal tick rate is measured later (N2 / #144); here
// it is just a configurable knob inside the documented 10–30 Hz band.

/** Room name registered with the Colyseus matchmaker. */
export const ROOM_NAME = 'game';

/** Default server simulation tick rate, Hz. Within the 10–30 Hz design band. */
export const DEFAULT_TICK_RATE = 20;
/** Lower bound of the supported tick band, Hz. */
export const MIN_TICK_RATE = 10;
/** Upper bound of the supported tick band, Hz. */
export const MAX_TICK_RATE = 30;

/** Max players per room (lobby band is 2–24; Colyseus enforces the max only). */
export const MAX_CLIENTS = 24;

/** Planar move speed applied to a unit move axis, world units/sec. */
export const PLAYER_SPEED = 5;
/** Arena is a square centred on origin; positions clamp to [-HALF, HALF]. */
export const ARENA_HALF = 25;

/** Per-tick probability a bot picks a new random heading. */
export const BOT_DIR_CHANGE_PROB = 0.05;

/** How often a MetricsSample line is flushed to metrics.jsonl, ms. */
export const DEFAULT_FLUSH_INTERVAL_MS = 1000;

/**
 * Estimated framing overhead added per emitted message to approximate
 * on-the-wire size for `transportBytesPerSec`. A WebSocket frame header is
 * 2–10 bytes (+4 mask bytes client→server) and Colyseus prefixes a 1-byte
 * message-type code. This is an ESTIMATE — `bytesUp/DownPerSec` carry the exact
 * application payload; `transportBytesPerSec` is explicitly the approximation.
 * See net/CLAUDE.md (units in names) and the PR notes (Codex caveat: this is
 * application payload + a constant, NOT measured TCP/WS wire bytes).
 */
export const FRAMING_OVERHEAD_BYTES = 8;
