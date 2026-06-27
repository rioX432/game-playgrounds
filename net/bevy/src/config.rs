//! Shared tunables for the N1 native networking sample. No magic numbers in
//! logic — everything configurable lives here. These mirror the web sample's
//! constants (`net/server/src/config.ts`, `net/web-three/src/config.ts`) so the
//! Bevy/replicon authority is an apples-to-apples mirror of the Colyseus one.

/// Default server simulation tick rate, Hz. Within the chapter's 10–30 Hz band
/// and identical to the web server's `DEFAULT_TICK_RATE` for comparability.
pub const TICK_RATE: f64 = 20.0;

/// Supported tick band (Hz), mirrors the web server's `MIN/MAX_TICK_RATE`. The
/// N2 tick-rate sweep (#147) clamps each stage into this band.
pub const MIN_TICK_RATE: f64 = 10.0;
pub const MAX_TICK_RATE: f64 = 30.0;

/// Per-tick probability a bot picks a new random heading (mirrors the web
/// `BOT_DIR_CHANGE_PROB`) — the N2 load-probe bot driver's only motion knob.
pub const BOT_DIR_CHANGE_PROB: f64 = 0.05;

/// Planar move speed applied to a unit move axis, world units/sec
/// (mirrors `PLAYER_SPEED` on the web server).
pub const PLAYER_SPEED: f32 = 5.0;

/// Arena is a square centred on origin; positions clamp to `[-HALF, HALF]`
/// (mirrors `ARENA_HALF`).
pub const ARENA_HALF: f32 = 25.0;

/// Interpolation delay expressed in SERVER TICKS. The client renders this many
/// ticks behind the freshest received state so it always has two samples to
/// blend (absorbs jitter + one dropped update). Mirrors web `INTERP_TICKS`.
pub const INTERP_TICKS: f64 = 2.0;

/// Max samples retained per entity in the interpolation buffer (~a few seconds).
pub const MAX_SAMPLES: usize = 60;

/// Boolean-state bitmasks packed into `RoleFlags` (mirrors `net-protocol`).
pub const FLAG_GROUNDED: u8 = 1 << 0;
pub const FLAG_FIRING: u8 = 1 << 1;

/// renet protocol id — MUST match on both ends or the handshake is rejected.
/// Arbitrary but stable for this sample.
pub const PROTOCOL_ID: u64 = 0x6e_65_74_62_76; // ascii "netbv"

/// Default UDP port the standalone server binds (the `--client` connects here).
pub const DEFAULT_PORT: u16 = 5010;

/// Derived: interpolation delay in seconds at the configured tick rate.
pub fn interp_delay_secs() -> f64 {
    INTERP_TICKS / TICK_RATE
}
