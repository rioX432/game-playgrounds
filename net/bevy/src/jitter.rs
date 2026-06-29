//! Cross-engine delay-JITTER sampler — the Rust port of the shared TS sampler
//! (`net/protocol/src/jitter.ts`, #159). The web `TransportShim` and this Bevy
//! `Conditioner` both add a per-delivery jitter offset from THIS sampler, so a
//! scenario seed produces the same jitter stream on both stacks.
//!
//! PARITY IS THE POINT. The math is deliberately TRANSCENDENTAL-FREE (no ln / cos
//! / powf), so given the same mulberry32 draws (`rng.rs` is a bit-for-bit port of
//! `rng.ts`) this sampler matches the TS one EXACTLY — pinned by the shared fixture
//! `net/protocol/src/jitterFixtures.json` (read by both the TS test and the Rust
//! `tests::matches_shared_jitter_fixture` here), exactly like the `aggregate_render_window`
//! precedent (#168).
//!
//! These are netem-MENU-aligned APPROXIMATIONS, not the exact netem distribution
//! tables: `normal` via Irwin–Hall (sum of uniforms), the long tail via a clamped
//! Lomax transform. Modeling constants are below, documented, not hidden. Keep this
//! in lockstep with `jitter.ts` — any change must regenerate the shared fixture.

use serde::{Deserialize, Serialize};

use crate::rng::Rng;

/// Jitter distribution shape (mirrors the TS `JitterDistribution`). `lowercase`
/// serde names match the shared fixture / manifest json (`none|normal|pareto|paretonormal`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JitterDistribution {
    /// No jitter (fast path; consumes NO rng draws).
    #[default]
    None,
    /// Symmetric, ≈ N(0, sigma) via Irwin–Hall. Delay can dip or rise.
    Normal,
    /// One-sided long tail (clamped Lomax). Occasional positive spikes.
    Pareto,
    /// 50/50 blend: a symmetric core plus a positive long tail.
    ParetoNormal,
}

/// Per-direction jitter knobs (mirrors the TS `JitterConfig`). `Copy` so it can
/// ride on the `Copy` `LinkConfig`/`Stage`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JitterConfig {
    /// Jitter magnitude, ms (std-dev-like). `<= 0` ⇒ no jitter regardless of shape.
    pub sigma_ms: f64,
    /// Distribution shape.
    pub distribution: JitterDistribution,
    /// Serial correlation with the previous sample, `[0, 1)`.
    pub correlation: f64,
}

impl JitterConfig {
    /// No jitter.
    pub const NONE: JitterConfig = JitterConfig {
        sigma_ms: 0.0,
        distribution: JitterDistribution::None,
        correlation: 0.0,
    };
}

/// Uniforms summed for the Irwin–Hall normal approximation (`sum(12 u) - 6` ≈ N(0,1)).
const IRWIN_HALL_N: usize = 12;
/// Half of `IRWIN_HALL_N` — the mean to subtract so the result is zero-centered.
const IRWIN_HALL_MEAN: f64 = IRWIN_HALL_N as f64 / 2.0;
/// Clamp on the Lomax tail unit so a single near-1 draw can't produce an absurd spike.
const PARETO_TAIL_CAP: f64 = 8.0;
/// Lomax median (at u=0.5, `u/(1-u)=1`); subtracted so `pareto` is ~zero-centered.
const PARETO_MEDIAN: f64 = 1.0;

/// Stateful per-link jitter sampler (mirrors the TS `JitterSampler`). Call
/// [`sample`](Self::sample) once per delivery for a signed jitter offset in ms; the
/// caller adds it to the base one-way delay and clamps at 0.
pub struct JitterSampler {
    config: JitterConfig,
    rng: Rng,
    prev: f64,
}

impl JitterSampler {
    /// Build a sampler from a config + a dedicated seeded stream.
    pub fn new(config: JitterConfig, rng: Rng) -> Self {
        Self {
            config,
            rng,
            prev: 0.0,
        }
    }

    /// True if this sampler always returns 0 and consumes no rng.
    pub fn is_noop(&self) -> bool {
        self.config.sigma_ms <= 0.0 || self.config.distribution == JitterDistribution::None
    }

    /// Next signed jitter offset, ms (may be negative for symmetric distributions).
    /// Named `sample` (not `next`) to avoid clashing with `Iterator::next`; the TS
    /// peer's `JitterSampler.next()` is the same operation (parity is by value).
    pub fn sample(&mut self) -> f64 {
        if self.is_noop() {
            return 0.0;
        }
        let fresh = self.config.sigma_ms * self.standard_draw();
        let c = self.config.correlation;
        let out = c * self.prev + (1.0 - c) * fresh;
        self.prev = out;
        out
    }

    /// One standardized (pre-sigma) draw for the configured distribution.
    fn standard_draw(&mut self) -> f64 {
        match self.config.distribution {
            JitterDistribution::None => 0.0,
            JitterDistribution::Normal => self.irwin_hall(),
            JitterDistribution::Pareto => self.lomax(),
            // Symmetric core + positive long tail, equally weighted (draw order:
            // Irwin–Hall THEN Lomax — must match the TS `0.5*irwinHall + 0.5*lomax`).
            JitterDistribution::ParetoNormal => 0.5 * self.irwin_hall() + 0.5 * self.lomax(),
        }
    }

    /// Irwin–Hall standard-normal approximation: sum of N uniforms minus the mean.
    fn irwin_hall(&mut self) -> f64 {
        let mut sum = 0.0;
        for _ in 0..IRWIN_HALL_N {
            sum += self.rng.next_f64();
        }
        sum - IRWIN_HALL_MEAN
    }

    /// Clamped, median-centered α=1 Lomax: a one-sided long tail.
    fn lomax(&mut self) -> f64 {
        let u = self.rng.next_f64();
        let tail = (u / (1.0 - u)).min(PARETO_TAIL_CAP);
        tail - PARETO_MEDIAN
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The SHARED fixture: the SAME json the TS parity test reads. Resolved relative
    /// to this crate so the Rust and TS samplers stay in lockstep.
    const FIXTURE: &str =
        concat!(env!("CARGO_MANIFEST_DIR"), "/../protocol/src/jitterFixtures.json");

    /// Expected values are exact-representable f64 (transcendental-free math); a tiny
    /// epsilon documents the intent (numeric equality, not approximation).
    const EPSILON: f64 = 1e-12;

    #[derive(Deserialize)]
    struct ParityCase {
        name: String,
        seed: u32,
        config: JitterConfig,
        count: usize,
        expected: Vec<f64>,
    }

    #[derive(Deserialize)]
    struct ParityFixture {
        cases: Vec<ParityCase>,
    }

    #[test]
    fn matches_shared_jitter_fixture() {
        let raw = std::fs::read_to_string(FIXTURE)
            .unwrap_or_else(|e| panic!("read shared fixture {FIXTURE}: {e}"));
        let fixture: ParityFixture = serde_json::from_str(&raw).expect("valid fixture json");
        assert!(!fixture.cases.is_empty(), "fixture must have cases");

        for case in fixture.cases {
            let mut sampler = JitterSampler::new(case.config, Rng::new(case.seed));
            let got: Vec<f64> = (0..case.count).map(|_| sampler.sample()).collect();
            assert_eq!(got.len(), case.expected.len(), "{}: length", case.name);
            for (i, (g, e)) in got.iter().zip(case.expected.iter()).enumerate() {
                assert!(
                    (g - e).abs() < EPSILON,
                    "{}: sample {i} {g} != {e} (TS parity)",
                    case.name
                );
            }
        }
    }

    #[test]
    fn noop_for_none_or_zero_sigma() {
        let mut s = JitterSampler::new(JitterConfig::NONE, Rng::new(5));
        assert!(s.is_noop());
        for _ in 0..10 {
            assert_eq!(s.sample(), 0.0);
        }
        let mut z = JitterSampler::new(
            JitterConfig {
                sigma_ms: 0.0,
                distribution: JitterDistribution::Normal,
                correlation: 0.0,
            },
            Rng::new(1),
        );
        assert!(z.is_noop());
        assert_eq!(z.sample(), 0.0);
    }

    #[test]
    fn reproducible_for_a_seed() {
        let cfg = JitterConfig {
            sigma_ms: 8.0,
            distribution: JitterDistribution::ParetoNormal,
            correlation: 0.3,
        };
        let run = || {
            let mut s = JitterSampler::new(cfg, Rng::new(99));
            (0..32).map(|_| s.sample()).collect::<Vec<_>>()
        };
        assert_eq!(run(), run());
    }

    #[test]
    fn pareto_is_one_sided_bounded_by_the_cap() {
        let sigma = 10.0;
        let mut s = JitterSampler::new(
            JitterConfig {
                sigma_ms: sigma,
                distribution: JitterDistribution::Pareto,
                correlation: 0.0,
            },
            Rng::new(42),
        );
        let xs: Vec<f64> = (0..500).map(|_| s.sample()).collect();
        let max = xs.iter().cloned().fold(f64::MIN, f64::max);
        let min = xs.iter().cloned().fold(f64::MAX, f64::min);
        // Cap 8, median 1 ⇒ max ≤ sigma*(8-1); min ≥ sigma*(0-1).
        assert!(max <= sigma * 7.0 + 1e-9, "max {max} exceeds cap");
        assert!(min >= -sigma - 1e-9, "min {min} below floor");
        assert!(max > sigma, "expected occasional spikes above the median");
    }
}
