//! Deterministic PRNG so a scenario seed reproduces a run — a direct port of the
//! web server's `net/server/src/sim/rng.ts` (mulberry32). Tiny, fast, good enough
//! for simulation jitter and loss draws; NOT cryptographic.
//!
//! Porting the SAME algorithm means a given seed produces the SAME bot-motion
//! draw sequence on both engines — useful when reasoning about cross-engine runs,
//! and it satisfies the #147 faithful-recording rule "bot motion reproducible
//! from a recorded seed". Each consumer gets its OWN stream (bot motion vs loss
//! draws never share one) so trajectories stay reproducible regardless of when
//! async loss draws happen.

/// A deterministic 32-bit-seeded RNG stream (mulberry32). `Clone` so a stream can
/// be snapshotted; not `Copy` to avoid accidental silent stream forks.
#[derive(Clone, Debug)]
pub struct Rng {
    state: u32,
}

impl Rng {
    /// Create a stream from a 32-bit seed.
    pub fn new(seed: u32) -> Self {
        Self { state: seed }
    }

    /// Next float in `[0, 1)` — bit-for-bit the mulberry32 of the web port.
    pub fn next_f64(&mut self) -> f64 {
        // wrapping arithmetic == JS `| 0` / `>>> 0` 32-bit semantics.
        self.state = self.state.wrapping_add(0x6d2b79f5);
        let mut t = self.state;
        t = (t ^ (t >> 15)).wrapping_mul(1 | t);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t));
        ((t ^ (t >> 14)) as f64) / 4294967296.0
    }

    /// Next float in `[min, max)`.
    pub fn range(&mut self, min: f64, max: f64) -> f64 {
        min + self.next_f64() * (max - min)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_js_mulberry32_golden_vector() {
        // Ground truth computed by running the web `rng.ts` algorithm in Node for
        // seed 42 (`node -e '...'`). Pins the "bit-for-bit with the web port" claim
        // so a future regression that the self-consistency tests can't see is caught.
        let mut r = Rng::new(42);
        let want = [
            0.601_103_751_920_163_6,
            0.448_290_558_997_541_67,
            0.852_465_793_490_409_8,
        ];
        for (i, w) in want.iter().enumerate() {
            let got = r.next_f64();
            assert!(
                (got - w).abs() < 1e-15,
                "draw {i}: got {got}, want {w} (JS mulberry32)"
            );
        }
    }

    #[test]
    fn is_deterministic_for_a_seed() {
        let mut a = Rng::new(42);
        let mut b = Rng::new(42);
        for _ in 0..100 {
            assert_eq!(a.next_f64(), b.next_f64());
        }
    }

    #[test]
    fn different_seeds_diverge() {
        let mut a = Rng::new(1);
        let mut b = Rng::new(2);
        // Overwhelmingly likely to differ within a few draws; assert on the first.
        assert_ne!(a.next_f64(), b.next_f64());
    }

    #[test]
    fn output_is_in_unit_interval() {
        let mut r = Rng::new(123);
        for _ in 0..1000 {
            let x = r.next_f64();
            assert!((0.0..1.0).contains(&x), "out of [0,1): {x}");
        }
    }

    #[test]
    fn range_stays_within_bounds() {
        let mut r = Rng::new(7);
        for _ in 0..1000 {
            let x = r.range(-2.0, 5.0);
            assert!((-2.0..5.0).contains(&x), "out of range: {x}");
        }
    }
}
