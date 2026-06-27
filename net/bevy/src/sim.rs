//! Pure authoritative simulation — render-free, transport-free, GPU-free.
//!
//! This is the server-authoritative core the chapter is about, mirroring the web
//! authority `net/server/src/sim/world.ts`: apply the latest input per entity,
//! integrate at a fixed step, clamp to the arena, and derive the boolean state
//! bitfield. Keeping it a set of free functions makes it `cargo test`-able with
//! no `App`, no window, and no socket — exactly the headless guarantee the issue
//! asks for. The replicon wiring that *calls* these lives in [`crate::server`].

use bevy::math::{Vec2, Vec3};

use crate::config::{ARENA_HALF, FLAG_FIRING, FLAG_GROUNDED, PLAYER_SPEED};

#[inline]
fn clamp(v: f32, lo: f32, hi: f32) -> f32 {
    v.clamp(lo, hi)
}

/// Integrate one entity one fixed step. The move axis is the authoritative input
/// (each component already clamped to `[-1, 1]`); the result is clamped to the
/// square arena. `y` is held flat (planar sample, mirrors the web `pos: [x,0,z]`).
pub fn integrate(pos: Vec3, move_axis: Vec2, dt: f32) -> Vec3 {
    let d = PLAYER_SPEED * dt;
    Vec3::new(
        clamp(pos.x + move_axis.x * d, -ARENA_HALF, ARENA_HALF),
        0.0,
        clamp(pos.z + move_axis.y * d, -ARENA_HALF, ARENA_HALF),
    )
}

/// Sanitize a raw input axis to `[-1, 1]` per component before it enters the
/// authoritative state (a hostile/buggy client must not inject super-speed).
pub fn sanitize_axis(raw: Vec2) -> Vec2 {
    Vec2::new(clamp(raw.x, -1.0, 1.0), clamp(raw.y, -1.0, 1.0))
}

/// Derive the replicated boolean-state bitfield from pressed buttons. Grounded is
/// always set in this planar sample; firing mirrors the input bit (mirrors
/// `buildSnapshot` on the web server).
pub fn flags_from_buttons(buttons: u8) -> u8 {
    let mut flags = FLAG_GROUNDED;
    if buttons & FLAG_FIRING != 0 {
        flags |= FLAG_FIRING;
    }
    flags
}

#[cfg(test)]
mod tests {
    use super::*;

    const DT: f32 = 1.0 / 20.0;

    #[test]
    fn integrate_moves_along_axis() {
        let p = integrate(Vec3::ZERO, Vec2::new(1.0, 0.0), DT);
        assert!(p.x > 0.0, "expected +x movement, got {p:?}");
        assert_eq!(p.y, 0.0, "stays planar");
        assert_eq!(p.z, 0.0);
        // Exactly PLAYER_SPEED * dt for a unit axis.
        assert!((p.x - PLAYER_SPEED * DT).abs() < 1e-6);
    }

    #[test]
    fn integrate_clamps_to_arena() {
        let far = Vec3::new(ARENA_HALF, 0.0, -ARENA_HALF);
        let p = integrate(far, Vec2::new(1.0, -1.0), DT);
        assert_eq!(p.x, ARENA_HALF, "clamps at +HALF");
        assert_eq!(p.z, -ARENA_HALF, "clamps at -HALF");
    }

    #[test]
    fn sanitize_axis_clamps_each_component() {
        let s = sanitize_axis(Vec2::new(5.0, -9.0));
        assert_eq!(s, Vec2::new(1.0, -1.0));
    }

    #[test]
    fn flags_grounded_always_firing_conditional() {
        assert_eq!(flags_from_buttons(0), FLAG_GROUNDED);
        assert_eq!(
            flags_from_buttons(FLAG_FIRING),
            FLAG_GROUNDED | FLAG_FIRING
        );
    }
}
