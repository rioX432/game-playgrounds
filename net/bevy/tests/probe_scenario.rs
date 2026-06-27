//! Headless N2 probe scenario run (#147) — the real-localhost-UDP integration
//! test for the load probe. It boots the authoritative server + a probe client,
//! ramps bots, runs a SHRUNK scenario (tiny windows so the test is fast), and
//! asserts every emitted line is a schema-valid #140 `MetricsSample` with
//! `engine = "bevy"` — both in-memory AND written to metrics.jsonl.
//!
//! Like `net_loopback.rs`, this loads ONLY the headless plugin set (no render, no
//! window) and drives `update()` manually via the runner's bounded pump loop.

use std::path::PathBuf;

use net_bevy::metrics::MetricsSample;
use net_bevy::probe::{run_scenario, RunOptions};
use net_bevy::scenario::{adhoc, ScenarioOpts, ShimConfig};

/// The 18 #140 field names — duplicated here (not imported) so the test pins the
/// on-disk JSON contract independently of the library's own constant.
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

/// A unique temp metrics.jsonl path (pid + nanos) so parallel test runs don't
/// clobber each other and we never depend on the repo working dir.
fn temp_metrics_path() -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("net-bevy-probe-{}-{}.jsonl", std::process::id(), nanos))
}

fn assert_schema_valid(line: &str, expect_bots: u32, expect_loss: f64) {
    // 1. The raw JSON object has EXACTLY the 18 #140 fields.
    let value: serde_json::Value = serde_json::from_str(line).expect("line is JSON");
    let obj = value.as_object().expect("JSON object");
    let mut got: Vec<&str> = obj.keys().map(String::as_str).collect();
    got.sort_unstable();
    let mut want: Vec<&str> = SCHEMA_FIELDS_140.to_vec();
    want.sort_unstable();
    assert_eq!(got, want, "metrics.jsonl line must have the #140 field set");

    // 2. It deserializes into the typed schema, with the expected labels.
    let s: MetricsSample = serde_json::from_str(line).expect("line deserializes to MetricsSample");
    assert_eq!(s.engine, "bevy", "engine must be bevy");
    assert_eq!(s.scenario, "adhoc");
    assert_eq!(s.bot_count, expect_bots);
    assert_eq!(s.loss_pct, expect_loss);

    // 3. Every numeric field is finite (no NaN/inf leaked into a sample).
    for v in [
        s.bytes_up_per_sec,
        s.bytes_down_per_sec,
        s.transport_bytes_per_sec,
        s.rtt_p50_ms,
        s.rtt_p95_ms,
        s.snapshot_age_ms,
        s.server_tick_sim_ms,
        s.server_tick_serialize_ms,
        s.server_tick_send_ms,
    ] {
        assert!(v.is_finite() && v >= 0.0, "metric must be finite & non-negative: {v}");
    }
}

#[test]
fn adhoc_scenario_emits_schema_valid_jsonl() {
    // A SHRUNK adhoc run: 1 probe client, a 1->3 bot ramp, tiny windows. A clean
    // shim keeps the run fast and deterministic in motion.
    let opts = ScenarioOpts {
        client_count: Some(1),
        bot_stages: Some(vec![1, 3]),
        warmup_ms: Some(80),
        measure_ms: Some(160),
        ..Default::default()
    };
    let def = adhoc(&opts);
    let path = temp_metrics_path();

    let samples = run_scenario(
        &def,
        RunOptions {
            seed: 7,
            metrics_path: Some(path.clone()),
            on_stage: None,
        },
    )
    .expect("scenario run");

    // One sample per stage, in order, with the ramped bot counts.
    assert_eq!(samples.len(), 2, "one sample per stage");
    assert_eq!(samples[0].bot_count, 1);
    assert_eq!(samples[1].bot_count, 3);
    assert_eq!(samples[0].seed, 7);
    // Downlink bytes should grow with the entity count (more bots replicated).
    assert!(
        samples[1].bytes_down_per_sec >= samples[0].bytes_down_per_sec,
        "more bots => at least as much downlink app payload"
    );

    // The on-disk JSONL matches the in-memory samples and the #140 schema.
    let contents = std::fs::read_to_string(&path).expect("metrics.jsonl written");
    let lines: Vec<&str> = contents.lines().filter(|l| !l.is_empty()).collect();
    assert_eq!(lines.len(), 2, "two JSONL lines written");
    assert_schema_valid(lines[0], 1, 0.0);
    assert_schema_valid(lines[1], 3, 0.0);

    let _ = std::fs::remove_file(&path);
}

#[test]
fn latency_sweep_stage_runs_and_records_injected_knobs() {
    // A single impaired stage (bidirectional 30 ms delay + 10% loss) must run
    // end-to-end and record the injected knobs / max-loss faithfully. This
    // exercises the app-level conditioner on a real UDP connection.
    let shim = ShimConfig::sym(30.0, 10.0);
    let opts = ScenarioOpts {
        client_count: Some(1),
        bot_stages: Some(vec![2]),
        shim: Some(shim),
        warmup_ms: Some(80),
        measure_ms: Some(200),
        ..Default::default()
    };
    let def = adhoc(&opts);

    let samples = run_scenario(&def, RunOptions { seed: 3, ..Default::default() })
        .expect("impaired scenario run");

    assert_eq!(samples.len(), 1);
    let s = &samples[0];
    assert_eq!(s.injected_delay_cto_s_ms, 30.0, "uplink delay recorded");
    assert_eq!(s.injected_delay_sto_c_ms, 30.0, "downlink delay recorded");
    assert_eq!(s.loss_pct, 10.0, "loss recorded as max(up,down)");
    assert_eq!(s.engine, "bevy");
    // With a downlink delay injected, the client buffers staler snapshots than the
    // tick period alone — snapshotAge should be clearly positive.
    assert!(s.snapshot_age_ms > 0.0, "snapshotAge must reflect buffered samples");
}
