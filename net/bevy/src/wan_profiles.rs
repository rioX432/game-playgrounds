//! Named WAN profiles — the Bevy mirror of `net/protocol/src/wanProfiles.ts`
//! (#159). Same ids and same numbers, so "4g-mobile" means the same impairment as
//! the web stack. Kept in lockstep with the TS source (like `rng.rs` mirrors
//! `rng.ts`); the values are grounded in the #159 research memo's cited sources.
//!
//! Injection is SYMMETRIC up/down. Reorder has no field — it EMERGES from jitter
//! (faithful here: renet is UDP; only APPROXIMATE on web). These are
//! localhost-injected presets, NOT a WAN benchmark.

use std::path::Path;

use serde::Serialize;

use crate::jitter::{JitterConfig, JitterDistribution};

/// A named transport-condition preset (applied symmetrically up + down).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WanProfile {
    /// Stable id (also the scenario-stage label) — matches the TS `WanProfileId`.
    pub id: &'static str,
    /// Base one-way delay, ms (RTT ≈ 2× this).
    pub one_way_delay_ms: f64,
    /// Jitter added on top of the base delay, per delivery.
    pub jitter: JitterConfig,
    /// Packet loss, percent in `[0, 100]`.
    pub loss_pct: f64,
}

/// All profiles, clean first (matches the TS registry order).
pub fn all_wan_profiles() -> [WanProfile; 4] {
    [
        // clean — zero-injection control.
        WanProfile {
            id: "clean",
            one_way_delay_ms: 0.0,
            jitter: JitterConfig::NONE,
            loss_pct: 0.0,
        },
        // good-wifi — ~20ms RTT, small symmetric ±3ms normal jitter, 0.1% loss.
        WanProfile {
            id: "good-wifi",
            one_way_delay_ms: 10.0,
            jitter: JitterConfig {
                sigma_ms: 3.0,
                distribution: JitterDistribution::Normal,
                correlation: 0.25,
            },
            loss_pct: 0.1,
        },
        // 4g-mobile — ~50ms RTT, ±10ms long-tailed pareto jitter, 1% loss.
        WanProfile {
            id: "4g-mobile",
            one_way_delay_ms: 25.0,
            jitter: JitterConfig {
                sigma_ms: 10.0,
                distribution: JitterDistribution::Pareto,
                correlation: 0.25,
            },
            loss_pct: 1.0,
        },
        // transcontinental — ~160ms RTT, ±20ms paretonormal jitter, 0.5% loss.
        WanProfile {
            id: "transcontinental",
            one_way_delay_ms: 80.0,
            jitter: JitterConfig {
                sigma_ms: 20.0,
                distribution: JitterDistribution::ParetoNormal,
                correlation: 0.5,
            },
            loss_pct: 0.5,
        },
    ]
}

/// Reorder-fidelity note for the Bevy stack — faithful (UDP), mirrors the TS
/// `REORDER_NOTE.bevy`.
pub const REORDER_NOTE_BEVY: &str =
    "Reorder emerges from jitter; faithful — renet runs over UDP (out-of-order \
     delivery is physical).";

/// One manifest entry — the profile knobs the thin `MetricsSample` does NOT carry.
/// camelCase to match the web `scenario-manifest.json` (`net-protocol`) so either
/// stack's sidecar reads with the same schema.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestEntry {
    scenario: String,
    profile: &'static str,
    one_way_delay_ms: f64,
    jitter_sigma_ms: f64,
    jitter_distribution: JitterDistribution,
    jitter_correlation: f64,
    loss_pct: f64,
    reorder_note: &'static str,
}

/// The sidecar file shape (mirrors the TS `ScenarioManifest`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScenarioManifest {
    seed: u32,
    engine: &'static str,
    note: String,
    entries: Vec<ManifestEntry>,
}

/// Write the `scenario-manifest.json` sidecar for the WAN sweep — the
/// jitter/distribution/correlation the thin `MetricsSample` deliberately omits.
/// Readers LEFT JOIN onto metrics.jsonl on scenario + injectedDelay* + lossPct.
pub fn write_wan_manifest(path: &Path, scenario: &str, seed: u32) -> std::io::Result<()> {
    let entries = all_wan_profiles()
        .iter()
        .map(|p| ManifestEntry {
            scenario: scenario.to_string(),
            profile: p.id,
            one_way_delay_ms: p.one_way_delay_ms,
            jitter_sigma_ms: p.jitter.sigma_ms,
            jitter_distribution: p.jitter.distribution,
            jitter_correlation: p.jitter.correlation,
            loss_pct: p.loss_pct,
            reorder_note: REORDER_NOTE_BEVY,
        })
        .collect();
    let manifest = ScenarioManifest {
        seed,
        engine: "bevy",
        note: "WAN-profile sweep sidecar. Join onto metrics.jsonl on scenario + injectedDelay* \
               + lossPct. Jitter is reproducible from the seed (shared sampler)."
            .to_string(),
        entries,
    };
    let json = serde_json::to_string_pretty(&manifest).expect("serialize manifest");
    std::fs::write(path, json + "\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_is_zero_injection_and_first() {
        let all = all_wan_profiles();
        assert_eq!(all[0].id, "clean");
        assert_eq!(all[0].one_way_delay_ms, 0.0);
        assert_eq!(all[0].loss_pct, 0.0);
        assert_eq!(all[0].jitter.distribution, JitterDistribution::None);
    }

    #[test]
    fn impaired_profiles_increase_delay_monotonically() {
        let all = all_wan_profiles();
        let delays: Vec<f64> = all.iter().map(|p| p.one_way_delay_ms).collect();
        let mut sorted = delays.clone();
        sorted.sort_by(f64::total_cmp);
        assert_eq!(delays, sorted, "profiles must be ordered by ascending delay");
        for p in all.iter().filter(|p| p.id != "clean") {
            assert!(p.one_way_delay_ms > 0.0);
            assert!(p.jitter.sigma_ms > 0.0);
            assert_ne!(p.jitter.distribution, JitterDistribution::None);
            assert!((0.0..1.0).contains(&p.jitter.correlation));
            assert!((0.0..100.0).contains(&p.loss_pct));
        }
    }
}
