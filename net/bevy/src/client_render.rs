//! Client-render measurement (#168) — the Bevy native consumer of the #165
//! sidecar contract (`net/protocol/src/clientRender.ts`).
//!
//! This is the native equivalent of the web render probes (#166 three, #167
//! babylon). It measures **client render performance** (frame-time p50/p95 + fps)
//! under N2 bot-ramp load on the windowed Bevy client, and emits one
//! [`ClientRenderSample`] per kept measurement window to a `client-render.jsonl`
//! sidecar with `engine="bevy"` and `measurementBasis="bevy-frame-diagnostics"`.
//!
//! ## Two layers, mirroring the web probe
//!
//! 1. A PURE sampler ([`aggregate_render_window`]) that reimplements the locked TS
//!    `aggregateRenderWindow` rules EXACTLY (nearest-rank percentiles, throttle
//!    exclusion, first-frame drop, wall-clock fps). It is kept in lockstep with the
//!    TS version by a SHARED checked-in fixture (`net/protocol/src/clientRenderFixtures.json`):
//!    a TS test and the Rust [`tests::matches_shared_parity_fixture`] test both read
//!    that json and assert the same expected aggregates. The pure layer is fully
//!    headless-testable (no window, no GPU).
//! 2. A stateful batcher ([`RenderProbe`]) that the windowed client feeds RAW
//!    per-frame frame-time into; it excludes warmup, closes fixed wall-clock
//!    windows, and emits a [`ClientRenderSample`] per kept window. Also headless
//!    (the caller supplies the clock + dt), so it unit-tests without a GPU window.
//!
//! ## Frame-time signal (Bevy 0.18, doc-verified)
//!
//! The RAW per-frame frame-time is read from Bevy's
//! [`FrameTimeDiagnosticsPlugin`]'s `FRAME_TIME` diagnostic (a `DiagnosticPath`,
//! "Frame time in ms"). We read [`Diagnostic::measurement`] — the LATEST raw
//! measurement (`value` = `Time<Real>` delta × 1000) — and NEVER
//! [`Diagnostic::smoothed`] (the EMA) or [`Diagnostic::average`] (the SMA). This is
//! the native analogue of the web rAF present-to-present delta. Verified against
//! docs.rs/bevy/0.18.1: `Diagnostic::value()`/`measurement()` return the most
//! recent raw value; the plugin's `smoothing_factor` only affects `.smoothed()`.
//! We dedupe by the measurement `Instant` so a frame with no new measurement (the
//! diagnostic system skips a zero delta) is not double-counted.
//!
//! See `net/bevy/CLAUDE.md` → "Honest-parity" for the web-vs-bevy parity caveat:
//! magnitudes are NOT cross-comparable; frame-time p50/p95 is the PRIMARY metric
//! and fps is a vsync-capped ceiling indicator.

use std::path::PathBuf;

use bevy::diagnostic::{DiagnosticsStore, FrameTimeDiagnosticsPlugin};
use bevy::platform::time::Instant;
use bevy::prelude::*;
use bevy_replicon::prelude::ClientState;
use serde::{Deserialize, Serialize};

use crate::client::InterpTrack;
use crate::metrics::ENGINE;

// --- Contract constants (mirror net/protocol/src/clientRender.ts) ---------------

/// A frame delta above this (ms) is a tab-throttle / suspend artifact: excluded
/// from the aggregates AND flags the window `throttled`. Mirrors the TS
/// `THROTTLE_MAX_MS` (strict `>` boundary — a delta of exactly 250 ms is KEPT).
pub const THROTTLE_MAX_MS: f64 = 250.0;

/// Minimum valid frame deltas for a window to be statistically usable. Mirrors the
/// TS `MIN_VALID_SAMPLES`. Below this the window is marked invalid.
pub const MIN_VALID_SAMPLES: usize = 30;

/// How a window's frame deltas were observed. The native Bevy frame-timing source
/// (vs the web's `web-raf-dt`). A locked value of the #165 `MeasurementBasis` union.
pub const MEASUREMENT_BASIS: &str = "bevy-frame-diagnostics";

/// Percent for the p50 (median) frame-time aggregate.
const P50: f64 = 50.0;
/// Percent for the p95 frame-time aggregate.
const P95: f64 = 95.0;
/// Milliseconds per second — keep fps math out of magic numbers.
const MS_PER_SEC: f64 = 1000.0;

// --- Pure sampler ---------------------------------------------------------------

/// Knobs for [`aggregate_render_window`] the caller owns (the pure function cannot
/// derive these from the deltas). Mirrors the TS `RenderWindowConfig`.
#[derive(Clone, Copy, Debug)]
pub struct RenderWindowConfig {
    /// Real wall-clock duration the caller accumulated `dt_ms` over, ms. Denominator
    /// for `client_fps`. Must be `> 0` for a valid window.
    pub window_duration_ms: f64,
    /// Drop the FIRST delta after start/resume (setup / stale-timestamp artifact).
    pub drop_first_frame: bool,
}

/// The render-performance subset + validity signals the sampler computes. Mirrors
/// the TS `RenderWindowAggregate`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RenderWindowAggregate {
    /// Delivered frames per second: `valid_frame_count / (window_duration_ms / 1000)`.
    pub client_fps: f64,
    /// Frame time, 50th percentile, ms (nearest-rank).
    pub client_frame_time_p50_ms: f64,
    /// Frame time, 95th percentile, ms (nearest-rank).
    pub client_frame_time_p95_ms: f64,
    /// Count of valid deltas used (after first-frame drop and throttle exclusion).
    pub sample_count: usize,
    /// True if any delta exceeded [`THROTTLE_MAX_MS`].
    pub throttled: bool,
    /// False when throttled OR fewer than [`MIN_VALID_SAMPLES`] valid deltas.
    pub valid: bool,
}

impl RenderWindowAggregate {
    /// The all-zero invalid aggregate (mirrors the TS `EMPTY_AGGREGATE`).
    const EMPTY: RenderWindowAggregate = RenderWindowAggregate {
        client_fps: 0.0,
        client_frame_time_p50_ms: 0.0,
        client_frame_time_p95_ms: 0.0,
        sample_count: 0,
        throttled: false,
        valid: false,
    };
}

/// Nearest-rank percentile over an ascending-sorted slice. IDENTICAL rule to the TS
/// `percentileNearestRank`: for `n` values the p-th percentile is the value at
/// 1-based rank `ceil(p/100 * n)`, clamped into `[1, n]`, then `- 1` for the index.
/// Precondition: `sorted_asc` is non-empty and sorted ascending.
fn percentile_nearest_rank(sorted_asc: &[f64], p: f64) -> f64 {
    let n = sorted_asc.len() as isize;
    let rank = ((p / 100.0) * n as f64).ceil() as isize;
    // Clamp into [1, n] (guards p=0/100 + float edges), then -1 for the 0-based index.
    let index = (rank.clamp(1, n) - 1) as usize;
    sorted_asc[index]
}

/// Aggregate raw frame deltas into client-render metrics. PURE: same inputs → same
/// outputs, no clock reads. Reimplements the TS `aggregateRenderWindow` rules
/// EXACTLY (the shared fixture pins the parity):
///  - drop the FIRST delta after start/resume (when `drop_first_frame`);
///  - a delta `> THROTTLE_MAX_MS` is excluded and flags `throttled`;
///  - fps = `valid_frame_count / (window_duration_ms / 1000)` (wall-clock window,
///    NOT `1000 / avg_dt`);
///  - percentiles come from the raw sorted deltas via the one nearest-rank rule;
///  - `valid` is false when throttled or under [`MIN_VALID_SAMPLES`];
///  - a non-positive `window_duration_ms` yields the all-zero invalid aggregate
///    (sample_count = 0, even if deltas were present — matches the TS early return).
pub fn aggregate_render_window(
    raw_dt_ms: &[f64],
    config: RenderWindowConfig,
) -> RenderWindowAggregate {
    // 1. Drop the first delta after start/resume.
    let after_drop: &[f64] = if config.drop_first_frame && !raw_dt_ms.is_empty() {
        &raw_dt_ms[1..]
    } else {
        raw_dt_ms
    };

    // 2. Split out throttle artifacts (excluded from aggregates; presence flags the
    //    window throttled so the caller can drop it).
    let mut throttled = false;
    let mut valid: Vec<f64> = Vec::with_capacity(after_drop.len());
    for &dt in after_drop {
        if dt > THROTTLE_MAX_MS {
            throttled = true;
            continue;
        }
        valid.push(dt);
    }

    if valid.is_empty() || config.window_duration_ms <= 0.0 {
        return RenderWindowAggregate {
            throttled,
            ..RenderWindowAggregate::EMPTY
        };
    }

    // 3. fps over the REAL wall-clock window (not the sum of deltas).
    let window_seconds = config.window_duration_ms / MS_PER_SEC;
    let client_fps = valid.len() as f64 / window_seconds;

    // 4. Percentiles directly from sorted raw deltas (foreground spikes preserved).
    let mut sorted = valid.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let client_frame_time_p50_ms = percentile_nearest_rank(&sorted, P50);
    let client_frame_time_p95_ms = percentile_nearest_rank(&sorted, P95);

    let sample_count = valid.len();
    let is_valid = !throttled && sample_count >= MIN_VALID_SAMPLES;

    RenderWindowAggregate {
        client_fps,
        client_frame_time_p50_ms,
        client_frame_time_p95_ms,
        sample_count,
        throttled,
        valid: is_valid,
    }
}

// --- Sample + join keys ---------------------------------------------------------

/// The join keys + per-client identity a [`ClientRenderSample`] carries verbatim.
/// Identical semantics to the server `MetricsSample` so a tool can LEFT JOIN the
/// two JSONL files. Mirrors the web probe's `RenderJoinKeys`.
///
/// NOTE: `client_count` is STRUCTURAL (a render probe connects exactly ONE real
/// rendering client) and is deliberately NOT a documented join key — see CLAUDE.md.
#[derive(Clone, Debug)]
pub struct RenderJoinKeys {
    pub scenario: String,
    pub seed: u64,
    pub tick_rate: f64,
    pub client_count: u32,
    pub bot_count: u32,
    pub injected_delay_cto_s_ms: f64,
    pub injected_delay_sto_c_ms: f64,
    pub loss_pct: f64,
    pub client_index: u32,
}

/// One client-render measurement window. Serialized one-per-line into
/// `client-render.jsonl`. Field set/order and camelCase names mirror the TS
/// `ClientRenderSample` interface EXACTLY (the
/// [`tests::sample_json_field_set_matches_165_contract`] test pins it).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClientRenderSample {
    // --- Join keys (identical semantics to MetricsSample) ---
    pub scenario: String,
    pub engine: String,
    pub seed: u64,
    pub tick_rate: f64,
    pub client_count: u32,
    pub bot_count: u32,
    pub injected_delay_cto_s_ms: f64,
    pub injected_delay_sto_c_ms: f64,
    pub loss_pct: f64,
    // --- Per-real-client identity ---
    pub client_index: u32,
    // --- Window framing ---
    pub window_start_ms: f64,
    pub window_duration_ms: f64,
    // --- Measured render performance ---
    pub client_fps: f64,
    pub client_frame_time_p50_ms: f64,
    pub client_frame_time_p95_ms: f64,
    pub sample_count: usize,
    pub measurement_basis: String,
}

/// Window framing the caller owns (the sampler cannot derive these from deltas).
#[derive(Clone, Copy, Debug)]
pub struct RenderWindowFraming {
    pub window_start_ms: f64,
    pub window_duration_ms: f64,
    pub drop_first_frame: bool,
}

/// PURE window → sample builder (mirrors the web `buildClientRenderSample`). Runs
/// the raw deltas through [`aggregate_render_window`] and, if the window is usable
/// (un-throttled AND valid), merges the aggregates with the join keys into a full
/// [`ClientRenderSample`]. Returns `None` for a throttled/invalid window so the
/// caller drops it (never records a background pause as foreground perf).
pub fn build_client_render_sample(
    raw_dt_ms: &[f64],
    framing: RenderWindowFraming,
    keys: &RenderJoinKeys,
) -> Option<ClientRenderSample> {
    let aggregate = aggregate_render_window(
        raw_dt_ms,
        RenderWindowConfig {
            window_duration_ms: framing.window_duration_ms,
            drop_first_frame: framing.drop_first_frame,
        },
    );

    if aggregate.throttled || !aggregate.valid {
        return None;
    }

    Some(ClientRenderSample {
        scenario: keys.scenario.clone(),
        engine: ENGINE.to_string(),
        seed: keys.seed,
        tick_rate: keys.tick_rate,
        client_count: keys.client_count,
        bot_count: keys.bot_count,
        injected_delay_cto_s_ms: keys.injected_delay_cto_s_ms,
        injected_delay_sto_c_ms: keys.injected_delay_sto_c_ms,
        loss_pct: keys.loss_pct,
        client_index: keys.client_index,
        window_start_ms: framing.window_start_ms,
        window_duration_ms: framing.window_duration_ms,
        client_fps: aggregate.client_fps,
        client_frame_time_p50_ms: aggregate.client_frame_time_p50_ms,
        client_frame_time_p95_ms: aggregate.client_frame_time_p95_ms,
        sample_count: aggregate.sample_count,
        measurement_basis: MEASUREMENT_BASIS.to_string(),
    })
}

// --- Stateful batcher (mirror of the web RenderProbe class) ---------------------

/// Stateful batching glue between the windowed render loop and the pure sampler.
/// The caller pushes `(now_ms, dt_ms)` per frame via [`RenderProbe::record_frame`];
/// the probe excludes warmup, closes fixed wall-clock windows, and returns a
/// [`ClientRenderSample`] for each KEPT window. Clock-injected (the caller supplies
/// `now_ms`), so it is fully unit-testable without a GPU window — exactly the part
/// the headless tests exercise.
#[derive(Debug)]
pub struct RenderProbe {
    keys: RenderJoinKeys,
    warmup_ms: f64,
    window_duration_ms: f64,
    max_windows: Option<usize>,

    ready_at_ms: Option<f64>,
    window_start_ms: Option<f64>,
    buffer: Vec<f64>,
    kept: usize,
}

impl RenderProbe {
    /// `max_windows = None` runs indefinitely; `Some(n)` stops after `n` KEPT windows.
    pub fn new(
        keys: RenderJoinKeys,
        warmup_ms: f64,
        window_duration_ms: f64,
        max_windows: Option<usize>,
    ) -> Self {
        Self {
            keys,
            warmup_ms,
            window_duration_ms,
            max_windows,
            ready_at_ms: None,
            window_start_ms: None,
            buffer: Vec::new(),
            kept: 0,
        }
    }

    /// Mark the client ready to measure (connected AND first snapshot received).
    /// Starts the warmup countdown; idempotent — only the FIRST call matters.
    pub fn mark_ready(&mut self, now_ms: f64) {
        if self.ready_at_ms.is_none() {
            self.ready_at_ms = Some(now_ms);
        }
    }

    /// Number of KEPT (emitted) windows so far.
    pub fn window_count(&self) -> usize {
        self.kept
    }

    /// True once the configured KEPT-window target is reached.
    pub fn done(&self) -> bool {
        self.max_windows.is_some_and(|m| self.kept >= m)
    }

    /// Feed one frame: `now_ms` is a monotonic clock, `dt_ms` is the RAW per-frame
    /// frame-time (never a smoothed/EMA value). Returns the emitted sample if this
    /// frame closed a KEPT window. Mirrors the web `RenderProbe.recordFrame` /
    /// `closeWindow`, but with the dt supplied directly (Bevy gives us the frame
    /// time) rather than derived from a present timestamp.
    pub fn record_frame(&mut self, now_ms: f64, dt_ms: f64) -> Option<ClientRenderSample> {
        // Not ready (not connected / no first snapshot) — nothing to measure.
        let ready_at = self.ready_at_ms?;
        // Inside the warmup window — excluded by design.
        if now_ms - ready_at < self.warmup_ms {
            return None;
        }
        // Target reached — stop accumulating.
        if self.done() {
            return None;
        }
        // Open the first window exactly at the warmup boundary; the boundary frame
        // contributes no delta (contiguous windows, no boundary artifact).
        let Some(window_start) = self.window_start_ms else {
            self.window_start_ms = Some(now_ms);
            return None;
        };

        // RAW per-frame delta — NEVER a smoothed/EMA value (#165 contract).
        self.buffer.push(dt_ms);

        if now_ms - window_start >= self.window_duration_ms {
            return self.close_window(now_ms);
        }
        None
    }

    /// Aggregate the live window, emit if kept, then start the next one contiguously.
    fn close_window(&mut self, now_ms: f64) -> Option<ClientRenderSample> {
        let window_start = self.window_start_ms.unwrap_or(now_ms);
        // Honest denominator: the ACTUAL wall-clock span the deltas covered, not the
        // configured target (a window closes on the first frame past the target).
        let actual_duration_ms = now_ms - window_start;

        let sample = build_client_render_sample(
            &self.buffer,
            RenderWindowFraming {
                window_start_ms: window_start,
                window_duration_ms: actual_duration_ms,
                // Contiguous windows post-warmup ⇒ no boundary artifact to drop.
                drop_first_frame: false,
            },
            &self.keys,
        );

        if sample.is_some() {
            self.kept += 1;
        }
        // Start the next window contiguously at this frame.
        self.window_start_ms = Some(now_ms);
        self.buffer.clear();
        sample
    }
}

// --- JSONL writer (append-only, one sample per line) ----------------------------

/// Append-only JSON Lines writer for [`ClientRenderSample`], one sample per line
/// (the net/ CLAUDE.md convention). Mirrors `metrics::MetricsWriter`.
pub struct ClientRenderWriter {
    path: PathBuf,
    ensured: bool,
}

impl ClientRenderWriter {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            ensured: false,
        }
    }

    /// Append one sample as a single JSON line, creating parent dirs on first use.
    pub fn write(&mut self, sample: &ClientRenderSample) -> std::io::Result<()> {
        use std::io::Write;
        if !self.ensured {
            if let Some(dir) = self.path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            self.ensured = true;
        }
        let line = serde_json::to_string(sample).expect("ClientRenderSample serializes");
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        writeln!(f, "{line}")
    }
}

// --- Windowed-client plugin (added ONLY by the `--client` binary, never tests) --

/// Resource wrapping the [`RenderProbe`] on the windowed client.
#[derive(Resource)]
pub struct ClientRenderProbeRes(pub RenderProbe);

/// Resource wrapping the sidecar JSONL writer on the windowed client.
#[derive(Resource)]
pub struct ClientRenderOutRes(pub ClientRenderWriter);

/// Tracks the `Instant` of the last consumed frame-time measurement, so a frame
/// with no NEW diagnostic measurement (the diagnostic system skips a zero delta)
/// is not double-counted.
#[derive(Resource, Default)]
struct LastFrameMeasurement(Option<Instant>);

/// The client render-under-load probe plugin. Added ONLY by the windowed
/// `--client` binary when the render-probe env is set; never loaded by tests
/// (the pure sampler + batcher are tested headless). Registers
/// [`FrameTimeDiagnosticsPlugin`] (the RAW frame-time source) and the per-frame
/// sampling system.
pub struct ClientRenderPlugin {
    pub keys: RenderJoinKeys,
    pub out_path: PathBuf,
    pub warmup_ms: f64,
    pub window_duration_ms: f64,
    pub max_windows: Option<usize>,
}

impl Plugin for ClientRenderPlugin {
    fn build(&self, app: &mut App) {
        app.add_plugins(FrameTimeDiagnosticsPlugin::default());
        app.insert_resource(ClientRenderProbeRes(RenderProbe::new(
            self.keys.clone(),
            self.warmup_ms,
            self.window_duration_ms,
            self.max_windows,
        )));
        app.insert_resource(ClientRenderOutRes(ClientRenderWriter::new(
            self.out_path.clone(),
        )));
        app.init_resource::<LastFrameMeasurement>();
        app.add_systems(Update, sample_client_frame);
    }
}

/// Per-frame: gate readiness (connected AND first snapshot), read the RAW latest
/// frame-time from the `FRAME_TIME` diagnostic (deduped by measurement `Instant`),
/// feed the probe, write any emitted sample, and exit once the window target is hit.
#[allow(clippy::too_many_arguments)]
fn sample_client_frame(
    real: Res<Time<Real>>,
    diagnostics: Res<DiagnosticsStore>,
    mut last: ResMut<LastFrameMeasurement>,
    mut probe: ResMut<ClientRenderProbeRes>,
    mut out: ResMut<ClientRenderOutRes>,
    client_state: Option<Res<State<ClientState>>>,
    tracks: Query<(), With<InterpTrack>>,
    // Bevy 0.18 renamed buffered `EventWriter` → `MessageWriter`; `AppExit` is a
    // `Message`. Used to terminate the windowed run once the window target is hit.
    mut exit: MessageWriter<AppExit>,
) {
    let now_ms = real.elapsed_secs_f64() * MS_PER_SEC;

    // Ready = connected AND a first snapshot has replicated (an InterpTrack exists).
    // This excludes connection + scene-setup + first-snapshot settling from warmup.
    let connected = client_state
        .as_ref()
        .is_some_and(|s| *s.get() == ClientState::Connected);
    if connected && !tracks.is_empty() {
        probe.0.mark_ready(now_ms);
    }

    // RAW latest frame-time (ms). `.measurement()` is the most recent raw value
    // (NOT `.smoothed()`); dedupe by its `Instant` so a frame without a new
    // measurement is not counted twice.
    let Some(diag) = diagnostics.get(&FrameTimeDiagnosticsPlugin::FRAME_TIME) else {
        return;
    };
    let Some(measurement) = diag.measurement() else {
        return;
    };
    if last.0 == Some(measurement.time) {
        return;
    }
    last.0 = Some(measurement.time);

    if let Some(sample) = probe.0.record_frame(now_ms, measurement.value) {
        if let Err(e) = out.0.write(&sample) {
            error!("client-render: failed to write sample: {e}");
        }
    }
    if probe.0.done() {
        exit.write(AppExit::Success);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- Shared parity fixture (the single source of truth with the TS sampler) ---

    // The fixture's `expected` object uses camelCase keys (the shared json is also
    // read by the TS test); serde rename_all maps them onto idiomatic snake_case.
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ParityExpected {
        client_fps: f64,
        client_frame_time_p50_ms: f64,
        client_frame_time_p95_ms: f64,
        sample_count: usize,
        throttled: bool,
        valid: bool,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ParityCase {
        name: String,
        raw_dt_ms: Vec<f64>,
        window_duration_ms: f64,
        drop_first_frame: bool,
        expected: ParityExpected,
    }

    #[derive(Deserialize)]
    struct ParityFixture {
        cases: Vec<ParityCase>,
    }

    /// Expected values in the fixture are exact-representable f64; assert within a
    /// tiny epsilon to document the intent (numeric equality, no float flakiness).
    const EPSILON: f64 = 1e-9;

    /// The SHARED fixture path: the SAME json the TS parity test reads. Resolved
    /// relative to this crate so the Rust and TS samplers stay in lockstep.
    const FIXTURE: &str =
        concat!(env!("CARGO_MANIFEST_DIR"), "/../protocol/src/clientRenderFixtures.json");

    #[test]
    fn matches_shared_parity_fixture() {
        let raw = std::fs::read_to_string(FIXTURE)
            .unwrap_or_else(|e| panic!("read shared fixture {FIXTURE}: {e}"));
        let fixture: ParityFixture = serde_json::from_str(&raw).expect("valid fixture json");
        assert!(!fixture.cases.is_empty(), "fixture must have cases");

        for case in fixture.cases {
            let expected = &case.expected;
            let out = aggregate_render_window(
                &case.raw_dt_ms,
                RenderWindowConfig {
                    window_duration_ms: case.window_duration_ms,
                    drop_first_frame: case.drop_first_frame,
                },
            );
            let n = &case.name;
            assert!(
                (out.client_fps - expected.client_fps).abs() < EPSILON,
                "{n}: fps {} != {}",
                out.client_fps,
                expected.client_fps
            );
            assert!(
                (out.client_frame_time_p50_ms - expected.client_frame_time_p50_ms).abs() < EPSILON,
                "{n}: p50 {} != {}",
                out.client_frame_time_p50_ms,
                expected.client_frame_time_p50_ms
            );
            assert!(
                (out.client_frame_time_p95_ms - expected.client_frame_time_p95_ms).abs() < EPSILON,
                "{n}: p95 {} != {}",
                out.client_frame_time_p95_ms,
                expected.client_frame_time_p95_ms
            );
            assert_eq!(out.sample_count, expected.sample_count, "{n}: sampleCount");
            assert_eq!(out.throttled, expected.throttled, "{n}: throttled");
            assert_eq!(out.valid, expected.valid, "{n}: valid");
        }
    }

    // --- ClientRenderSample JSON contract (mirror of the TS interface) ---

    /// The 17 #165 `ClientRenderSample` field names, in interface order. Pinned so a
    /// rename/add/drop (or a wrong serde rename) fails the build — the contract that
    /// keeps Bevy's client-render.jsonl joinable with the web sidecars.
    const SAMPLE_FIELDS_165: [&str; 17] = [
        "scenario",
        "engine",
        "seed",
        "tickRate",
        "clientCount",
        "botCount",
        "injectedDelayCtoSMs",
        "injectedDelayStoCMs",
        "lossPct",
        "clientIndex",
        "windowStartMs",
        "windowDurationMs",
        "clientFps",
        "clientFrameTimeP50Ms",
        "clientFrameTimeP95Ms",
        "sampleCount",
        "measurementBasis",
    ];

    fn dummy_keys() -> RenderJoinKeys {
        RenderJoinKeys {
            scenario: "n2-stress-ramp".to_string(),
            seed: 12345,
            tick_rate: 20.0,
            client_count: 1,
            bot_count: 24,
            injected_delay_cto_s_ms: 0.0,
            injected_delay_sto_c_ms: 0.0,
            loss_pct: 0.0,
            client_index: 0,
        }
    }

    #[test]
    fn sample_json_field_set_matches_165_contract() {
        // 60 valid 16 ms deltas over a 1 s window ⇒ a kept (valid) sample.
        let dt: Vec<f64> = vec![16.0; 61];
        let sample = build_client_render_sample(
            &dt,
            RenderWindowFraming {
                window_start_ms: 2000.0,
                window_duration_ms: 1000.0,
                drop_first_frame: true,
            },
            &dummy_keys(),
        )
        .expect("valid window yields a sample");

        let value: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&sample).unwrap()).unwrap();
        let obj = value.as_object().expect("JSON object");

        let mut got: Vec<&str> = obj.keys().map(String::as_str).collect();
        got.sort_unstable();
        let mut want: Vec<&str> = SAMPLE_FIELDS_165.to_vec();
        want.sort_unstable();
        assert_eq!(got, want, "client-render field set must equal the #165 contract");
        assert_eq!(value["engine"], "bevy");
        assert_eq!(value["measurementBasis"], MEASUREMENT_BASIS);
    }

    // --- RenderProbe batching (mirror of the web RenderProbe headless tests) ---

    #[test]
    fn probe_excludes_warmup_then_emits_a_kept_window() {
        let mut probe = RenderProbe::new(dummy_keys(), 100.0, 200.0, Some(1));
        // Not ready: frames are ignored entirely.
        assert!(probe.record_frame(0.0, 16.0).is_none());

        probe.mark_ready(0.0);
        // Inside warmup (< 100 ms): excluded.
        assert!(probe.record_frame(50.0, 16.0).is_none());

        // First post-warmup frame opens the window (no delta recorded yet).
        let mut now = 100.0;
        assert!(probe.record_frame(now, 16.0).is_none());

        // Accumulate ~250 ms of 16 ms frames; the window (200 ms) closes and, with
        // >= MIN_VALID_SAMPLES valid deltas, emits one kept sample.
        let mut emitted = None;
        for _ in 0..40 {
            now += 6.0;
            if let Some(s) = probe.record_frame(now, 16.0) {
                emitted = Some(s);
                break;
            }
        }
        let sample = emitted.expect("a window should have closed and been kept");
        assert_eq!(sample.engine, "bevy");
        assert_eq!(sample.measurement_basis, MEASUREMENT_BASIS);
        assert_eq!(sample.client_index, 0);
        assert!(sample.sample_count >= MIN_VALID_SAMPLES);
        assert_eq!(probe.window_count(), 1);
        assert!(probe.done());
    }

    #[test]
    fn probe_drops_a_throttled_window() {
        // No max — keep going. One huge suspend delta throttles the whole window,
        // which must be dropped (returns None, not counted).
        let mut probe = RenderProbe::new(dummy_keys(), 0.0, 100.0, None);
        probe.mark_ready(0.0);
        let mut now = 0.0;
        probe.record_frame(now, 16.0); // opens the window
        let mut closed_any = false;
        for i in 0..40 {
            now += 6.0;
            // Inject a throttle artifact partway through.
            let dt = if i == 10 { THROTTLE_MAX_MS + 500.0 } else { 16.0 };
            if probe.record_frame(now, dt).is_some() {
                closed_any = true;
            }
        }
        // The throttled window was dropped; nothing kept from it.
        assert_eq!(probe.window_count(), 0, "throttled window must not be kept");
        let _ = closed_any;
    }

    #[test]
    fn percentile_nearest_rank_matches_ts_rule() {
        // [10,20,30,40]: p50 -> rank ceil(0.5*4)=2 -> idx1 -> 20; p95 -> rank4 -> 40.
        let xs = [10.0, 20.0, 30.0, 40.0];
        assert!((percentile_nearest_rank(&xs, P50) - 20.0).abs() < EPSILON);
        assert!((percentile_nearest_rank(&xs, P95) - 40.0).abs() < EPSILON);
    }
}
