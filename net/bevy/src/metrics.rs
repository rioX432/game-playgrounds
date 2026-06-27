//! N2 measurement schema — the Rust mirror of `net/protocol/src/metrics.ts`
//! (the LOCKED #140 `MetricsSample`), plus the windowed accumulator that reduces
//! raw per-tick signals into one sample, and the append-only JSONL writer.
//!
//! One [`MetricsSample`] == one line of `metrics.jsonl`. It serializes (via
//! `#[serde(rename_all = "camelCase")]`) to the IDENTICAL JSON shape as the
//! TypeScript schema — same 18 fields, same camelCase names, units in the names —
//! so the web (#144) and Bevy (#147) probes' `metrics.jsonl` can be joined
//! apples-to-apples on `scenario` + stage for the #148 cross-engine diff. The
//! [`tests::sample_json_field_set_matches_140_schema`] test pins that contract:
//! it fails the build if a field is renamed, added, or dropped.
//!
//! HONEST-PARITY NOTES (Core Value #1 — every metric is measured, never faked;
//! where Bevy/replicon cannot mirror the web measurement, the difference is
//! recorded here and in `net/bevy/CLAUDE.md`, not papered over):
//! - `bytesUp/DownPerSec` are **app payload in Bevy's native encoding (postcard)**,
//!   the same bytes replicon serializes — vs the web probe's JSON payload. Absolute
//!   byte counts therefore differ by encoding, which is a real stack property. Note
//!   the uplink is sent at the tick rate (not the web's fixed 30 Hz), so the
//!   `bytesUp` axis is not cross-comparable under a tick sweep — see CLAUDE.md GAP 3.
//! - `transportBytesPerSec` is **actual renet wire bytes** (`ConnectedClientStats`
//!   from `RenetServer::network_info`), not an estimate like the web's
//!   "payload + constant". It is renet-packet bytes (incl. renet framing; excl.
//!   netcode encryption tag + UDP/IP headers), sampled over renet's 6 s window.
//! - `rttP50/P95Ms` are **renet transport RTT** over the real localhost link; they
//!   do NOT include app-level injected delay (the conditioner sits above netcode).
//! - `serverTickSerializeMs` = replicon's `ServerSystems::Send` (build + postcard
//!   serialize into `ServerMessages`); `serverTickSendMs` = `SendPackets` + renet
//!   flush to the socket. This is the best honest split replicon exposes.

use std::time::Instant;

use bevy::prelude::Resource;
use serde::{Deserialize, Serialize};

/// One measurement point in a networking scenario run. Field set and names are
/// LOCKED to the #140 schema (`net/protocol/src/metrics.ts`) — see the module
/// doc and the parity test. `engine` is always `"bevy"` for this crate.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MetricsSample {
    /// Scenario id, e.g. `"n2-stress-ramp"`. Groups samples across a run.
    pub scenario: String,
    /// Engine the sample was measured on (always `"bevy"` here).
    pub engine: String,
    /// RNG seed for the run — makes a scenario's bot motion reproducible.
    pub seed: u64,
    /// Server simulation tick rate, in Hz.
    pub tick_rate: f64,
    /// Number of connected probe clients at sample time.
    pub client_count: u32,
    /// Number of server-driven bots at sample time.
    pub bot_count: u32,

    /// Application payload sent client→server, bytes/sec (postcard-encoded inputs).
    pub bytes_up_per_sec: f64,
    /// Application payload sent server→client, bytes/sec (postcard-encoded snapshot).
    pub bytes_down_per_sec: f64,
    /// Actual on-the-wire bytes/sec from renet (`ConnectedClientStats`, both dirs).
    pub transport_bytes_per_sec: f64,

    /// Round-trip time, 50th percentile, ms (renet transport RTT).
    pub rtt_p50_ms: f64,
    /// Round-trip time, 95th percentile, ms.
    pub rtt_p95_ms: f64,
    /// Age of the snapshot being interpolated/rendered, ms (interp buffer depth).
    pub snapshot_age_ms: f64,

    /// Per server tick: simulation cost, ms (bot drive + authoritative integrate).
    pub server_tick_sim_ms: f64,
    /// Per server tick: replicon serialize cost, ms (`ServerSystems::Send`).
    pub server_tick_serialize_ms: f64,
    /// Per server tick: send/flush cost, ms (`SendPackets` + renet socket flush).
    pub server_tick_send_ms: f64,

    /// Injected one-way delay, client→server, ms (network-condition knob).
    pub injected_delay_cto_s_ms: f64,
    /// Injected one-way delay, server→client, ms.
    pub injected_delay_sto_c_ms: f64,
    /// Injected packet loss, percent [0..100] — recorded as `max(up, down)`.
    pub loss_pct: f64,
}

/// Static context that labels a sample (not measured — supplied by the scenario
/// stage). Mirrors the web collector's `SampleContext`.
#[derive(Clone, Debug)]
pub struct SampleContext {
    pub scenario: String,
    pub seed: u64,
    pub tick_rate: f64,
    pub client_count: u32,
    pub bot_count: u32,
    pub injected_delay_cto_s_ms: f64,
    pub injected_delay_sto_c_ms: f64,
    /// Loss recorded in the thin single-field schema as `max(up, down)` so an
    /// asymmetric run never under-reports impairment (carried over from #144).
    pub loss_pct: f64,
}

/// Floor on a window's elapsed seconds, so a degenerate (near-zero) window cannot
/// divide a byte counter to infinity.
const MIN_ELAPSED_SEC: f64 = 1e-3;

/// Nearest-rank percentile of an ascending-sorted slice; 0 if empty. Identical
/// algorithm to the web collector's `percentile` so the two engines compute RTT
/// percentiles the same way.
fn percentile(sorted_asc: &[f64], p: f64) -> f64 {
    let n = sorted_asc.len();
    if n == 0 {
        return 0.0;
    }
    let rank = ((p / 100.0) * n as f64).ceil() as isize;
    let idx = (rank - 1).clamp(0, n as isize - 1) as usize;
    sorted_asc[idx]
}

fn mean(xs: &[f64]) -> f64 {
    if xs.is_empty() {
        0.0
    } else {
        xs.iter().sum::<f64>() / xs.len() as f64
    }
}

/// Accumulates raw per-tick / per-update signals over a measurement window and
/// reduces them into one [`MetricsSample`]. A Bevy `Resource` on the server app:
/// the server's measurement systems record into it; the scenario runner resets it
/// after warmup and reduces it at the window close (mirrors the web
/// `MetricsCollector`).
///
/// Two kinds of signal:
/// - **Counters** (`up_bytes`, `down_bytes`): summed, divided by elapsed seconds.
/// - **Samples** (everything else): one value per tick/update, reduced by
///   mean/percentile. Transport bps and RTT are gauges read each update from
///   renet; `snapshot_age_ms` is pushed by the runner from the client app.
#[derive(Resource)]
pub struct MetricsAccumulator {
    up_bytes: f64,
    down_bytes: f64,
    transport_bps: Vec<f64>,
    rtt_ms: Vec<f64>,
    snapshot_age_ms: Vec<f64>,
    sim_ms: Vec<f64>,
    serialize_ms: Vec<f64>,
    send_ms: Vec<f64>,
    window_start: Instant,
}

impl Default for MetricsAccumulator {
    fn default() -> Self {
        Self {
            up_bytes: 0.0,
            down_bytes: 0.0,
            transport_bps: Vec::new(),
            rtt_ms: Vec::new(),
            snapshot_age_ms: Vec::new(),
            sim_ms: Vec::new(),
            serialize_ms: Vec::new(),
            send_ms: Vec::new(),
            window_start: Instant::now(),
        }
    }
}

impl MetricsAccumulator {
    /// Offered application bytes, client→server (one input message). Counted when
    /// the server receives it, BEFORE the uplink conditioner may drop it — so a
    /// dropped input still counts as offered load (mirrors the web `recordUp`).
    pub fn record_up(&mut self, bytes: f64) {
        self.up_bytes += bytes;
    }

    /// Offered application bytes, server→client (one snapshot to one client).
    pub fn record_down(&mut self, bytes: f64) {
        self.down_bytes += bytes;
    }

    /// One per-tick server-cost breakdown sample, ms (test convenience; the live
    /// systems record sim and replication separately — see below — because they
    /// run in different schedules, `FixedUpdate` vs `PostUpdate`).
    pub fn record_tick(&mut self, sim_ms: f64, serialize_ms: f64, send_ms: f64) {
        self.record_sim_ms(sim_ms);
        self.record_replication_ms(serialize_ms, send_ms);
    }

    /// One authoritative-simulation cost sample, ms (bot drive + integrate),
    /// measured in `FixedUpdate`.
    pub fn record_sim_ms(&mut self, ms: f64) {
        self.sim_ms.push(ms);
    }

    /// One replication cost sample, ms — `serialize_ms` is replicon's
    /// `ServerSystems::Send` (build + postcard into `ServerMessages`); `send_ms` is
    /// `SendPackets` + the renet `RenetSend` socket flush. Measured in `PostUpdate`.
    pub fn record_replication_ms(&mut self, serialize_ms: f64, send_ms: f64) {
        self.serialize_ms.push(serialize_ms);
        self.send_ms.push(send_ms);
    }

    /// One per-update transport byte-rate gauge (sum over connected clients of
    /// renet sent+received bps), bytes/sec.
    pub fn record_transport_bps(&mut self, bps: f64) {
        self.transport_bps.push(bps);
    }

    /// One renet transport RTT sample for a connected client, ms.
    pub fn record_rtt(&mut self, ms: f64) {
        self.rtt_ms.push(ms);
    }

    /// One snapshot-age sample (client interp-buffer depth), ms.
    pub fn record_snapshot_age(&mut self, ms: f64) {
        self.snapshot_age_ms.push(ms);
    }

    /// Discard the current window WITHOUT emitting — drops a post-ramp warmup
    /// window so the next sample is not polluted by ramp transients (#144).
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// Reduce the current window into one [`MetricsSample`] and reset. The static
    /// labels come from `ctx`; the measured values from the accumulated signals.
    pub fn reduce(&mut self, ctx: &SampleContext) -> MetricsSample {
        let elapsed_sec = (self.window_start.elapsed().as_secs_f64()).max(MIN_ELAPSED_SEC);
        let mut rtt_sorted = self.rtt_ms.clone();
        rtt_sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

        let sample = MetricsSample {
            scenario: ctx.scenario.clone(),
            engine: ENGINE.to_string(),
            seed: ctx.seed,
            tick_rate: ctx.tick_rate,
            client_count: ctx.client_count,
            bot_count: ctx.bot_count,
            bytes_up_per_sec: self.up_bytes / elapsed_sec,
            bytes_down_per_sec: self.down_bytes / elapsed_sec,
            transport_bytes_per_sec: mean(&self.transport_bps),
            rtt_p50_ms: percentile(&rtt_sorted, 50.0),
            rtt_p95_ms: percentile(&rtt_sorted, 95.0),
            snapshot_age_ms: mean(&self.snapshot_age_ms),
            server_tick_sim_ms: mean(&self.sim_ms),
            server_tick_serialize_ms: mean(&self.serialize_ms),
            server_tick_send_ms: mean(&self.send_ms),
            injected_delay_cto_s_ms: ctx.injected_delay_cto_s_ms,
            injected_delay_sto_c_ms: ctx.injected_delay_sto_c_ms,
            loss_pct: ctx.loss_pct,
        };
        self.reset();
        sample
    }
}

/// The engine label stamped on every Bevy sample. Single source of truth.
pub const ENGINE: &str = "bevy";

/// Serialize one sample to a single JSON line (no trailing newline). The JSONL
/// writer adds the `\n`; tests use this to assert the on-disk shape.
pub fn to_json_line(sample: &MetricsSample) -> String {
    // Field order/types are fixed by the struct; serde_json cannot fail here.
    serde_json::to_string(sample).expect("MetricsSample serializes")
}

/// Append-only JSON Lines writer: one [`MetricsSample`] per line (the net/
/// CLAUDE.md convention — no arrays, no nesting). IO is isolated here.
pub struct MetricsWriter {
    path: std::path::PathBuf,
    ensured: bool,
}

impl MetricsWriter {
    pub fn new(path: impl Into<std::path::PathBuf>) -> Self {
        Self {
            path: path.into(),
            ensured: false,
        }
    }

    /// Append one sample as a single JSON line, creating parent dirs on first use.
    pub fn write(&mut self, sample: &MetricsSample) -> std::io::Result<()> {
        use std::io::Write;
        if !self.ensured {
            if let Some(dir) = self.path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            self.ensured = true;
        }
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        writeln!(f, "{}", to_json_line(sample))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The 18 #140 field names, in schema order. Pinned here so a rename/add/drop
    /// in `MetricsSample` (or a wrong serde rename) fails the build — the contract
    /// that keeps Bevy's metrics.jsonl joinable with the web probe's.
    const SCHEMA_FIELDS_140: [&str; 18] = [
        "scenario",
        "engine",
        "seed",
        "tickRate",
        "clientCount",
        "botCount",
        "bytesUpPerSec",
        "bytesDownPerSec",
        "transportBytesPerSec",
        "rttP50Ms",
        "rttP95Ms",
        "snapshotAgeMs",
        "serverTickSimMs",
        "serverTickSerializeMs",
        "serverTickSendMs",
        "injectedDelayCtoSMs",
        "injectedDelayStoCMs",
        "lossPct",
    ];

    fn dummy() -> MetricsSample {
        MetricsSample {
            scenario: "n2-stress-ramp".to_string(),
            engine: ENGINE.to_string(),
            seed: 1,
            tick_rate: 20.0,
            client_count: 2,
            bot_count: 24,
            bytes_up_per_sec: 1.0,
            bytes_down_per_sec: 2.0,
            transport_bytes_per_sec: 3.0,
            rtt_p50_ms: 4.0,
            rtt_p95_ms: 5.0,
            snapshot_age_ms: 6.0,
            server_tick_sim_ms: 7.0,
            server_tick_serialize_ms: 8.0,
            server_tick_send_ms: 9.0,
            injected_delay_cto_s_ms: 10.0,
            injected_delay_sto_c_ms: 11.0,
            loss_pct: 12.0,
        }
    }

    #[test]
    fn sample_json_field_set_matches_140_schema() {
        let value: serde_json::Value =
            serde_json::from_str(&to_json_line(&dummy())).expect("valid JSON");
        let obj = value.as_object().expect("JSON object");

        // Exact field set: nothing missing, nothing extra (the schema is thin).
        let mut got: Vec<&str> = obj.keys().map(String::as_str).collect();
        got.sort_unstable();
        let mut want: Vec<&str> = SCHEMA_FIELDS_140.to_vec();
        want.sort_unstable();
        assert_eq!(got, want, "metrics.jsonl field set must equal the #140 schema");
    }

    #[test]
    fn engine_field_is_bevy() {
        let value: serde_json::Value =
            serde_json::from_str(&to_json_line(&dummy())).expect("valid JSON");
        assert_eq!(value["engine"], "bevy");
    }

    #[test]
    fn percentile_nearest_rank_matches_web_algorithm() {
        // [10,20,30,40] — p50 nearest-rank = ceil(0.5*4)=2 -> index 1 -> 20.
        let xs = [10.0, 20.0, 30.0, 40.0];
        assert_eq!(percentile(&xs, 50.0), 20.0);
        assert_eq!(percentile(&xs, 95.0), 40.0);
        assert_eq!(percentile(&[], 50.0), 0.0);
    }

    #[test]
    fn reduce_divides_byte_counters_by_elapsed() {
        let mut acc = MetricsAccumulator::default();
        acc.record_up(100.0);
        acc.record_down(200.0);
        acc.record_tick(1.0, 2.0, 3.0);
        acc.record_transport_bps(5000.0);
        acc.record_rtt(8.0);
        acc.record_snapshot_age(12.0);
        let ctx = SampleContext {
            scenario: "adhoc".to_string(),
            seed: 7,
            tick_rate: 20.0,
            client_count: 1,
            bot_count: 4,
            injected_delay_cto_s_ms: 0.0,
            injected_delay_sto_c_ms: 0.0,
            loss_pct: 0.0,
        };
        let s = acc.reduce(&ctx);
        assert_eq!(s.engine, "bevy");
        assert_eq!(s.seed, 7);
        // Bytes are positive and finite (exact rate depends on tiny real elapsed).
        assert!(s.bytes_up_per_sec > 0.0 && s.bytes_up_per_sec.is_finite());
        assert!(s.bytes_down_per_sec > 0.0 && s.bytes_down_per_sec.is_finite());
        assert_eq!(s.server_tick_sim_ms, 1.0);
        assert_eq!(s.server_tick_serialize_ms, 2.0);
        assert_eq!(s.server_tick_send_ms, 3.0);
        assert_eq!(s.transport_bytes_per_sec, 5000.0);
        assert_eq!(s.rtt_p50_ms, 8.0);
        assert_eq!(s.snapshot_age_ms, 12.0);
        // reduce() resets: a second reduce on the empty window is all-zero metrics.
        let s2 = acc.reduce(&ctx);
        assert_eq!(s2.server_tick_sim_ms, 0.0);
        assert_eq!(s2.transport_bytes_per_sec, 0.0);
    }
}
