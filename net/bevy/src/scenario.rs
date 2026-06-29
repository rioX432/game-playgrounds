//! N2 load-probe scenario model + named scenarios — the Bevy mirror of
//! `net/server/src/scenarios/{types,defs}.ts` (#144).
//!
//! Scenario ids and stage shapes are kept IDENTICAL to the web probe so the two
//! engines' `metrics.jsonl` join on `scenario` + stage index for the #148 diff.
//! A scenario is an ordered list of measurement STAGES; each stage pins the
//! app-construction params (`tick_rate`, `shim`, `client_count`) plus the
//! live-rampable `bot_count`, and the window timing. The runner emits exactly one
//! `MetricsSample` per stage (see [`crate::probe`]).

use crate::conditioner::LinkConfig;
use crate::wan_profiles::{all_wan_profiles, WanProfile};

/// Bidirectional impairment for a stage (mirrors the web `ShimConfig`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ShimConfig {
    /// client → server link.
    pub up: LinkConfig,
    /// server → client link.
    pub down: LinkConfig,
}

impl ShimConfig {
    /// No impairment in either direction.
    pub const CLEAN: ShimConfig = ShimConfig {
        up: LinkConfig::CLEAN,
        down: LinkConfig::CLEAN,
    };

    /// Symmetric bidirectional impairment (same delay + loss up and down).
    pub fn sym(delay_ms: f64, loss_pct: f64) -> Self {
        Self {
            up: LinkConfig::new(delay_ms, loss_pct),
            down: LinkConfig::new(delay_ms, loss_pct),
        }
    }

    /// Translate a WAN profile (#159) into a symmetric shim — same base delay,
    /// jitter, and loss up AND down. Mirrors the web `profileToShim`.
    pub fn from_profile(p: &WanProfile) -> Self {
        let link = LinkConfig::with_jitter(p.one_way_delay_ms, p.loss_pct, p.jitter);
        Self {
            up: link,
            down: link,
        }
    }

    /// Loss recorded in the thin single-field #140 schema: `max(up, down)`, so an
    /// asymmetric run never under-reports its impairment (the non-negotiable
    /// faithful-recording rule carried over from #144).
    pub fn loss_pct(&self) -> f64 {
        self.up.loss_pct.max(self.down.loss_pct)
    }
}

/// One measurement point: app params + bot load + window timing.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Stage {
    /// Server-driven bot count (the sync-entity load). Live-ramped within a segment.
    pub bot_count: usize,
    /// Connected probe clients (RTT / snapshot-age sources).
    pub client_count: usize,
    /// Server tick rate, Hz (clamped to the 10–30 band when the app is built).
    pub tick_rate: f64,
    /// Bidirectional impairment for this stage.
    pub shim: ShimConfig,
    /// Settle time after applying this stage's `bot_count` BEFORE the measured
    /// window opens (discarded so the sample is not polluted by ramp transients).
    pub warmup_ms: u64,
    /// Length of the measured window whose averages become the sample.
    pub measure_ms: u64,
}

/// A named, ordered set of stages.
#[derive(Clone, Debug)]
pub struct ScenarioDef {
    /// Scenario id, stamped on every emitted `MetricsSample` (e.g. `"n2-stress-ramp"`).
    pub id: String,
    /// Honest-feel notes / caveats for interpreting this scenario's samples.
    pub notes: String,
    /// The stages, run in order.
    pub stages: Vec<Stage>,
}

// --- Defaults (identical values to the web `defs.ts`) ---
const DEFAULT_WARMUP_MS: u64 = 500;
const DEFAULT_MEASURE_MS: u64 = 1500;
const DEFAULT_CLIENTS: usize = 2;
const DEFAULT_TICK: f64 = 20.0;
const DEFAULT_FIXED_BOTS: usize = 24;
const ADHOC_DEFAULT_BOTS: usize = 8;
/// The sync-entity ramp: 2 → 100 server bots (single fresh app, live-ramped).
const DEFAULT_BOT_STAGES: [usize; 6] = [2, 8, 16, 24, 50, 100];
/// Tick rates probed for the cost/freshness optimum (within the 10–30 band).
const DEFAULT_TICKS: [f64; 4] = [10.0, 15.0, 20.0, 30.0];

/// Default bidirectional sweep: clean → delay ramp → delay+loss (mirrors web).
fn default_shim_points() -> Vec<ShimConfig> {
    vec![
        ShimConfig::sym(0.0, 0.0),
        ShimConfig::sym(25.0, 0.0),
        ShimConfig::sym(50.0, 0.0),
        ShimConfig::sym(100.0, 0.0),
        ShimConfig::sym(50.0, 5.0),
        ShimConfig::sym(50.0, 10.0),
    ]
}

/// Common knobs every builder understands; `None` fields take the default. Mirrors
/// the web `ScenarioOpts` so a CLI/test can shrink a run without forking the def.
#[derive(Clone, Debug, Default)]
pub struct ScenarioOpts {
    pub client_count: Option<usize>,
    pub tick_rate: Option<f64>,
    pub bot_count: Option<usize>,
    pub bot_stages: Option<Vec<usize>>,
    pub ticks: Option<Vec<f64>>,
    pub shim_points: Option<Vec<ShimConfig>>,
    /// Single shim for the adhoc scenario.
    pub shim: Option<ShimConfig>,
    pub warmup_ms: Option<u64>,
    pub measure_ms: Option<u64>,
}

impl ScenarioOpts {
    fn warmup(&self) -> u64 {
        self.warmup_ms.unwrap_or(DEFAULT_WARMUP_MS)
    }
    fn measure(&self) -> u64 {
        self.measure_ms.unwrap_or(DEFAULT_MEASURE_MS)
    }
    fn clients(&self) -> usize {
        self.client_count.unwrap_or(DEFAULT_CLIENTS)
    }
    fn tick(&self) -> f64 {
        self.tick_rate.unwrap_or(DEFAULT_TICK)
    }
}

/// `n2-stress-ramp`: ramp the synchronized-entity count at a FIXED tick and zero
/// impairment. All stages share app params, so the runner uses ONE app + clients
/// and live-ramps the bots — the faithful "load grows under a steady server" shape.
pub fn n2_stress_ramp(o: &ScenarioOpts) -> ScenarioDef {
    let stages = o
        .bot_stages
        .clone()
        .unwrap_or_else(|| DEFAULT_BOT_STAGES.to_vec())
        .into_iter()
        .map(|bot_count| Stage {
            bot_count,
            client_count: o.clients(),
            tick_rate: o.tick(),
            shim: ShimConfig::CLEAN,
            warmup_ms: o.warmup(),
            measure_ms: o.measure(),
        })
        .collect();
    ScenarioDef {
        id: "n2-stress-ramp".to_string(),
        notes: "Sync-entity ramp at fixed tick / zero impairment. Single app, live bot ramp. \
                bytesDownPerSec + serverTickSerializeMs scale with botCount; serverTickSendMs \
                valid (zero down-delay)."
            .to_string(),
        stages,
    }
}

/// `n2-latency-sweep`: hold bots fixed and sweep the bidirectional shim. Each
/// point has a different shim, so the runner boots a FRESH app per stage.
pub fn n2_latency_sweep(o: &ScenarioOpts) -> ScenarioDef {
    let stages = o
        .shim_points
        .clone()
        .unwrap_or_else(default_shim_points)
        .into_iter()
        .map(|shim| Stage {
            bot_count: o.bot_count.unwrap_or(DEFAULT_FIXED_BOTS),
            client_count: o.clients(),
            tick_rate: o.tick(),
            shim,
            warmup_ms: o.warmup(),
            measure_ms: o.measure(),
        })
        .collect();
    ScenarioDef {
        id: "n2-latency-sweep".to_string(),
        notes: "Bidirectional shim sweep at fixed bots/tick. lossPct = max(up,down). \
                CAVEAT: rttP50/P95Ms are renet TRANSPORT RTT and do NOT reflect the app-level \
                injected delay; the delay shows up in snapshotAge (down) instead."
            .to_string(),
        stages,
    }
}

/// `n2-tickrate-sweep`: hold bots fixed and sweep the tick rate to find the
/// cost/freshness optimum. tickRate is fixed at app build, so each rate is a
/// FRESH app.
pub fn n2_tickrate_sweep(o: &ScenarioOpts) -> ScenarioDef {
    let stages = o
        .ticks
        .clone()
        .unwrap_or_else(|| DEFAULT_TICKS.to_vec())
        .into_iter()
        .map(|tick_rate| Stage {
            bot_count: o.bot_count.unwrap_or(DEFAULT_FIXED_BOTS),
            client_count: o.clients(),
            tick_rate,
            shim: ShimConfig::CLEAN,
            warmup_ms: o.warmup(),
            measure_ms: o.measure(),
        })
        .collect();
    ScenarioDef {
        id: "n2-tickrate-sweep".to_string(),
        notes: "Tick-rate sweep at fixed bots / zero impairment. Higher tick = fresher snapshots \
                (lower snapshotAge) but more serverTick + downlink bytes/sec. Fresh app per rate."
            .to_string(),
        stages,
    }
}

/// `n2-wan-profile-sweep` (#159): hold bots/tick fixed and sweep the named WAN
/// profiles (clean → good-wifi → 4g-mobile → transcontinental). Each profile has a
/// distinct delay/loss (and jitter), so the runner boots a FRESH app per stage. The
/// realized jitter/distribution/correlation per stage is recorded in the
/// `scenario-manifest.json` sidecar (the thin `MetricsSample` is unchanged); join a
/// metrics line to its profile on `scenario` + `injectedDelay*` + `lossPct`.
pub fn n2_wan_profile_sweep(o: &ScenarioOpts) -> ScenarioDef {
    let stages = all_wan_profiles()
        .iter()
        .map(|profile| Stage {
            bot_count: o.bot_count.unwrap_or(DEFAULT_FIXED_BOTS),
            client_count: o.clients(),
            tick_rate: o.tick(),
            shim: ShimConfig::from_profile(profile),
            warmup_ms: o.warmup(),
            measure_ms: o.measure(),
        })
        .collect();
    ScenarioDef {
        id: "n2-wan-profile-sweep".to_string(),
        notes: "Named WAN-profile sweep at fixed bots/tick (clean→good-wifi→4g-mobile→\
                transcontinental). Fresh app per profile. lossPct = max(up,down); base delay in \
                injectedDelay*; jitter/distribution/correlation in scenario-manifest.json (join on \
                scenario+delay+loss). Reorder is emergent from jitter and FAITHFUL here (UDP). \
                rttP50/P95Ms are renet TRANSPORT RTT and do NOT reflect injected delay/jitter; \
                those surface in snapshotAge (down) instead."
            .to_string(),
        stages,
    }
}

/// `adhoc`: a single-shim bot ramp driven entirely by the caller's options — the
/// env-configured run. One app, live bot ramp.
pub fn adhoc(o: &ScenarioOpts) -> ScenarioDef {
    let shim = o.shim.unwrap_or(ShimConfig::CLEAN);
    let stages = o
        .bot_stages
        .clone()
        .unwrap_or_else(|| vec![o.bot_count.unwrap_or(ADHOC_DEFAULT_BOTS)])
        .into_iter()
        .map(|bot_count| Stage {
            bot_count,
            client_count: o.clients(),
            tick_rate: o.tick(),
            shim,
            warmup_ms: o.warmup(),
            measure_ms: o.measure(),
        })
        .collect();
    ScenarioDef {
        id: "adhoc".to_string(),
        notes: "Caller-configured single-shim bot ramp (env-driven). One app, live bot ramp."
            .to_string(),
        stages,
    }
}

/// Build a named scenario by id, or `None` if the id is unknown (CLI validation).
pub fn build(id: &str, opts: &ScenarioOpts) -> Option<ScenarioDef> {
    match id {
        "n2-stress-ramp" => Some(n2_stress_ramp(opts)),
        "n2-latency-sweep" => Some(n2_latency_sweep(opts)),
        "n2-tickrate-sweep" => Some(n2_tickrate_sweep(opts)),
        "n2-wan-profile-sweep" => Some(n2_wan_profile_sweep(opts)),
        "adhoc" => Some(adhoc(opts)),
        _ => None,
    }
}

/// Known scenario ids (for CLI help / validation).
pub fn scenario_ids() -> [&'static str; 5] {
    [
        "n2-stress-ramp",
        "n2-latency-sweep",
        "n2-tickrate-sweep",
        "n2-wan-profile-sweep",
        "adhoc",
    ]
}

/// App-construction identity of a stage: stages sharing it can reuse one app boot
/// and live-ramp bots between them. The key spans `tick_rate`, `client_count`, and
/// the FULL shim (BOTH directions' delay AND loss) — any of these differing forces
/// a fresh boot, since tick + conditioner config are fixed at construction. Only
/// `bot_count` (and window timing) may vary within a segment. Mirrors the web
/// `segmentKey` (`runner.ts`).
fn segment_key(s: &Stage) -> String {
    let sh = &s.shim;
    // Jitter is fixed at construction too (it rides on the conditioner), so it MUST
    // be part of the room-identity key — else two stages with equal delay/loss but
    // different jitter would wrongly share an app boot.
    let jk = |j: &crate::jitter::JitterConfig| {
        format!("{}/{:?}/{}", j.sigma_ms, j.distribution, j.correlation)
    };
    format!(
        "{}|{}|{}/{}/{}|{}/{}/{}",
        s.tick_rate,
        s.client_count,
        sh.up.delay_ms,
        sh.up.loss_pct,
        jk(&sh.up.jitter),
        sh.down.delay_ms,
        sh.down.loss_pct,
        jk(&sh.down.jitter),
    )
}

/// Group stages into maximal consecutive runs that share app-construction params.
/// Each group becomes one app boot; bots ramp live within it. Pure + exported so
/// the grouping decision is unit-testable without booting any app (mirrors the web
/// `planSegments`).
pub fn plan_segments(stages: &[Stage]) -> Vec<Vec<Stage>> {
    let mut segments: Vec<Vec<Stage>> = Vec::new();
    let mut current: Vec<Stage> = Vec::new();
    let mut key: Option<String> = None;
    for stage in stages {
        let k = segment_key(stage);
        if key.as_deref() != Some(&k) {
            if !current.is_empty() {
                segments.push(std::mem::take(&mut current));
            }
            key = Some(k);
        }
        current.push(*stage);
    }
    if !current.is_empty() {
        segments.push(current);
    }
    segments
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stress_ramp_uses_default_ramp_and_clean_shim() {
        let def = n2_stress_ramp(&ScenarioOpts::default());
        assert_eq!(def.id, "n2-stress-ramp");
        let counts: Vec<usize> = def.stages.iter().map(|s| s.bot_count).collect();
        assert_eq!(counts, DEFAULT_BOT_STAGES.to_vec());
        assert!(def.stages.iter().all(|s| s.shim == ShimConfig::CLEAN));
    }

    #[test]
    fn stress_ramp_is_one_segment_latency_sweep_is_many() {
        // Same tick/clients/shim across the ramp -> ONE segment (live bot ramp).
        let ramp = n2_stress_ramp(&ScenarioOpts::default());
        assert_eq!(plan_segments(&ramp.stages).len(), 1);

        // Each sweep point has a distinct shim -> a fresh segment per stage.
        let sweep = n2_latency_sweep(&ScenarioOpts::default());
        assert_eq!(plan_segments(&sweep.stages).len(), sweep.stages.len());
    }

    #[test]
    fn loss_pct_records_max_of_up_and_down() {
        let asym = ShimConfig {
            up: LinkConfig::new(0.0, 0.0),
            down: LinkConfig::new(0.0, 20.0),
        };
        assert_eq!(asym.loss_pct(), 20.0, "asymmetric loss must not under-report");
    }

    #[test]
    fn opts_override_defaults() {
        let o = ScenarioOpts {
            bot_stages: Some(vec![2, 100]),
            client_count: Some(1),
            warmup_ms: Some(50),
            measure_ms: Some(100),
            ..Default::default()
        };
        let def = n2_stress_ramp(&o);
        assert_eq!(def.stages.len(), 2);
        assert_eq!(def.stages[0].client_count, 1);
        assert_eq!(def.stages[1].bot_count, 100);
        assert_eq!(def.stages[0].measure_ms, 100);
    }

    #[test]
    fn build_rejects_unknown_id() {
        assert!(build("nope", &ScenarioOpts::default()).is_none());
        assert!(build("adhoc", &ScenarioOpts::default()).is_some());
    }

    #[test]
    fn wan_profile_sweep_has_one_fresh_app_per_profile_with_jitter() {
        let def = n2_wan_profile_sweep(&ScenarioOpts::default());
        assert_eq!(def.id, "n2-wan-profile-sweep");
        let profiles = all_wan_profiles();
        assert_eq!(def.stages.len(), profiles.len());
        // First stage is the clean control.
        assert_eq!(def.stages[0].shim, ShimConfig::CLEAN);
        // Each stage carries its profile delay/loss/jitter symmetrically.
        for (stage, profile) in def.stages.iter().zip(profiles.iter()) {
            assert_eq!(stage.shim.up.delay_ms, profile.one_way_delay_ms);
            assert_eq!(stage.shim.down.delay_ms, profile.one_way_delay_ms);
            assert_eq!(stage.shim.up.jitter, profile.jitter);
            assert_eq!(stage.shim.up, stage.shim.down);
        }
        // Distinct delay/loss (and jitter) per profile ⇒ a fresh app boot per stage.
        assert_eq!(plan_segments(&def.stages).len(), def.stages.len());
    }

    #[test]
    fn wan_profile_jitter_is_in_the_segment_key() {
        // Two stages, equal delay/loss but different jitter, must NOT share an app.
        let base = LinkConfig::new(20.0, 0.0);
        let jittered = LinkConfig::with_jitter(
            20.0,
            0.0,
            crate::jitter::JitterConfig {
                sigma_ms: 5.0,
                distribution: crate::jitter::JitterDistribution::Normal,
                correlation: 0.0,
            },
        );
        let mk = |link: LinkConfig| Stage {
            bot_count: 8,
            client_count: 1,
            tick_rate: 20.0,
            shim: ShimConfig { up: link, down: link },
            warmup_ms: 0,
            measure_ms: 0,
        };
        assert_eq!(plan_segments(&[mk(base), mk(jittered)]).len(), 2);
    }
}
