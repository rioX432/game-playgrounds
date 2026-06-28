//! net-bevy binary — one binary, two roles: `--server` or `--client`.
//!
//! ```bash
//! cargo run -- --server                 # headless authority on 127.0.0.1:5010
//! cargo run -- --client                 # windowed client → 127.0.0.1:5010
//! cargo run -- --client 127.0.0.1:5010  # windowed client → explicit host:port
//! cargo run -- --scenario               # headless N2 load probe → metrics.jsonl
//! ```
//!
//! The render / net-sim split is visible right here: the `--server` role loads
//! the headless `MinimalPlugins` stack (no window), while only the `--client`
//! role adds `DefaultPlugins` + `NetRenderPlugin`. `--scenario` is fully headless
//! (the N2 load probe — see [`net_bevy::probe`]).

use std::net::{Ipv4Addr, SocketAddr};
use std::time::{SystemTime, UNIX_EPOCH};

use bevy::prelude::*;

use net_bevy::client::NetClientSimPlugin;
use net_bevy::client_render::{ClientRenderPlugin, RenderJoinKeys};
use net_bevy::conditioner::LinkConfig;
use net_bevy::config::{DEFAULT_PORT, TICK_RATE};
use net_bevy::probe::{run_scenario, RunOptions};
use net_bevy::protocol::NetProtocolPlugin;
use net_bevy::render::NetRenderPlugin;
use net_bevy::scenario::{self, ScenarioOpts, ShimConfig};
use net_bevy::{
    add_replication_plugins, build_loaded_server_app, build_server_app, start_client, start_server,
};

const MAX_CLIENTS: usize = 24;

// --- Loaded-server + render-probe defaults (env knobs; mirror the web probe) -----
/// Default RNG seed for the loaded server / render probe (matches the committed web
/// runs in `net/measurements/n2`).
const DEFAULT_SEED: u32 = 12345;
/// Default bot count for the loaded server / render-probe join key.
const DEFAULT_BOTS: usize = 24;
/// Default connected real-client count (a render probe connects exactly one).
const DEFAULT_CLIENT_COUNT: u32 = 1;
/// Default 0-based real-client index.
const DEFAULT_CLIENT_INDEX: u32 = 0;
/// Default settling window excluded before measuring, ms (mirrors web `warmupMs`).
const DEFAULT_WARMUP_MS: f64 = 2000.0;
/// Default measurement window length, ms (matches the committed web window params).
const DEFAULT_WINDOW_MS: f64 = 4000.0;
/// Default number of KEPT windows to capture before exiting.
const DEFAULT_MAX_WINDOWS: i64 = 3;

fn main() {
    let mut args = std::env::args().skip(1);
    let role = args.next();
    match role.as_deref() {
        Some("--server") => run_server(),
        Some("--client") => {
            let addr = args
                .next()
                .map(|s| s.parse().expect("invalid server address (host:port)"))
                .unwrap_or_else(default_addr);
            run_client(addr);
        }
        Some("--server-loaded") => run_server_loaded(),
        Some("--scenario") => run_scenario_cli(),
        _ => {
            eprintln!(
                "usage: net-bevy --server | --server-loaded | --client [host:port] | --scenario"
            );
            std::process::exit(2);
        }
    }
}

/// Run the N2 load probe headlessly and append `MetricsSample` lines to a
/// `metrics.jsonl`. Env-configured (all optional), mirroring the web
/// `npm run scenario` knobs so the two probes drive identically:
///
/// `SCENARIO SEED OUT WARMUP_MS MEASURE_MS CLIENTS TICK BOTS BOT_COUNT TICKS
/// DELAY_UP_MS DELAY_DOWN_MS LOSS_UP_PCT LOSS_DOWN_PCT`
///
/// `BOTS` / `TICKS` accept comma ramps (e.g. `BOTS=2,24,100`).
fn run_scenario_cli() {
    let id = env_str("SCENARIO", "n2-stress-ramp");
    let seed: u32 = env_parse("SEED", 1);
    let out = env_str("OUT", "metrics.jsonl");

    let shim = ShimConfig {
        up: LinkConfig::new(env_parse("DELAY_UP_MS", 0.0), env_parse("LOSS_UP_PCT", 0.0)),
        down: LinkConfig::new(env_parse("DELAY_DOWN_MS", 0.0), env_parse("LOSS_DOWN_PCT", 0.0)),
    };
    let opts = ScenarioOpts {
        client_count: env_opt("CLIENTS"),
        tick_rate: env_opt("TICK"),
        bot_count: env_opt("BOT_COUNT"),
        bot_stages: env_list("BOTS"),
        ticks: env_list("TICKS"),
        shim_points: None,
        shim: if shim == ShimConfig::CLEAN { None } else { Some(shim) },
        warmup_ms: env_opt("WARMUP_MS"),
        measure_ms: env_opt("MEASURE_MS"),
    };

    let Some(def) = scenario::build(&id, &opts) else {
        eprintln!(
            "unknown SCENARIO '{id}'. known: {}",
            scenario::scenario_ids().join(", ")
        );
        std::process::exit(2);
    };

    println!(
        "net-bevy probe: scenario={id} seed={seed} stages={} -> {out}",
        def.stages.len()
    );
    println!("notes: {}", def.notes);

    let run = run_scenario(
        &def,
        RunOptions {
            seed,
            metrics_path: Some(out.clone().into()),
            on_stage: Some(Box::new(|s, _stage, i| {
                println!(
                    "  [{i}] bots={:<3} clients={} sim={:.3}ms ser={:.3}ms send={:.3}ms \
                     down={:.0}B/s wire={:.0}B/s rttP50={:.2}ms age={:.1}ms loss={}%",
                    s.bot_count,
                    s.client_count,
                    s.server_tick_sim_ms,
                    s.server_tick_serialize_ms,
                    s.server_tick_send_ms,
                    s.bytes_down_per_sec,
                    s.transport_bytes_per_sec,
                    s.rtt_p50_ms,
                    s.snapshot_age_ms,
                    s.loss_pct,
                );
            })),
        },
    );
    match run {
        Ok(samples) => println!("wrote {} sample(s) to {out}", samples.len()),
        Err(e) => {
            eprintln!("scenario run failed: {e}");
            std::process::exit(1);
        }
    }
}

/// Read an env var as a string, or a default.
fn env_str(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

/// Read a non-empty env var (unset OR empty/whitespace-only reads as absent, so
/// `BOTS=` falls back to the default rather than aborting the run).
fn env_present(key: &str) -> Option<String> {
    match std::env::var(key) {
        Ok(v) if !v.trim().is_empty() => Some(v),
        _ => None,
    }
}

/// Parse an env var into `T`, or a default. A present-but-malformed value is a hard
/// error — no silent fallback that would mislabel a run.
fn env_parse<T: std::str::FromStr>(key: &str, default: T) -> T
where
    T::Err: std::fmt::Display,
{
    env_opt(key).unwrap_or(default)
}

/// Parse an optional env var into `Some(T)`, or `None` if unset/empty.
fn env_opt<T: std::str::FromStr>(key: &str) -> Option<T>
where
    T::Err: std::fmt::Display,
{
    env_present(key).map(|v| {
        v.trim()
            .parse()
            .unwrap_or_else(|e| panic!("env {key}='{v}' is not parseable: {e}"))
    })
}

/// Parse a comma-separated env list into `Some(Vec<T>)`, or `None` if unset/empty.
/// Empty items (e.g. a trailing comma) are skipped.
fn env_list<T: std::str::FromStr>(key: &str) -> Option<Vec<T>>
where
    T::Err: std::fmt::Display,
{
    env_present(key).map(|v| {
        v.split(',')
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(|p| {
                p.parse()
                    .unwrap_or_else(|e| panic!("env {key} item '{p}' is not parseable: {e}"))
            })
            .collect()
    })
}

fn default_addr() -> SocketAddr {
    SocketAddr::from((Ipv4Addr::LOCALHOST, DEFAULT_PORT))
}

/// A per-process client id (nanos since epoch) so two local clients don't clash.
fn fresh_client_id() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(1)
}

fn run_server() {
    let mut app = build_server_app();
    let addr =
        start_server(&mut app, default_addr(), MAX_CLIENTS).expect("failed to bind server socket");
    // `println!`, not `info!`: the headless server uses `MinimalPlugins`, which
    // has no `LogPlugin`, so a `tracing` line would be swallowed.
    println!("net-bevy server listening on {addr}");
    app.run();
}

/// The #168 loaded-server harness: the NORMAL headless authority WITH a seeded bot
/// ramp active, so the windowed `--client` (carrying the render probe) measures
/// client render perf under bot-driven sync load. Env knobs (all optional):
/// `SEED TICK BOT_COUNT` — the join keys stamped on the render samples. Additive;
/// it does NOT emit `metrics.jsonl` (a render-probe run measures the CLIENT).
fn run_server_loaded() {
    let seed: u32 = env_parse("SEED", DEFAULT_SEED);
    let tick: f64 = env_parse("TICK", TICK_RATE);
    let bot_count: usize = env_parse("BOT_COUNT", DEFAULT_BOTS);
    let mut app = build_loaded_server_app(tick, seed, bot_count);
    let addr =
        start_server(&mut app, default_addr(), MAX_CLIENTS).expect("failed to bind server socket");
    println!(
        "net-bevy loaded server listening on {addr} (tick={tick} seed={seed} bots={bot_count})"
    );
    app.run();
}

fn run_client(server_addr: SocketAddr) {
    let mut app = App::new();
    // Windowed: DefaultPlugins (NOT the headless MinimalPlugins) so the client
    // has a window, renderer and keyboard. DefaultPlugins already includes the
    // states plugin replicon needs; the replication plugins are shared with the
    // headless apps via `add_replication_plugins` so the wiring can't drift.
    app.add_plugins(DefaultPlugins);
    add_replication_plugins(&mut app);
    app.add_plugins((NetProtocolPlugin, NetClientSimPlugin, NetRenderPlugin));
    // Opt-in client render-under-load probe (#168). OFF for ordinary play; enabled
    // by `RENDER_PROBE=1`, writing one `ClientRenderSample` per kept window to
    // `RENDER_OUT`. `RENDER_OUT` (NOT `OUT`) is deliberately distinct from the
    // chapter-wide server-metrics `OUT` convention used by `--scenario`.
    maybe_add_render_probe(&mut app);
    start_client(&mut app, server_addr, fresh_client_id()).expect("failed to bind client socket");
    info!("net-bevy client connecting to {server_addr}");
    app.run();
}

/// Wire the client render probe iff `RENDER_PROBE=1`. Join keys come from env so a
/// run's samples line up with a loaded-server bot-ramp stage (`scenario` / `seed` /
/// `tickRate` / `botCount` + impairment knobs). `clientCount` is STRUCTURAL (always
/// one real rendering client) — not a join key. Output path is `RENDER_OUT`.
fn maybe_add_render_probe(app: &mut App) {
    if env_str("RENDER_PROBE", "0") != "1" {
        return;
    }
    let keys = RenderJoinKeys {
        scenario: env_str("SCENARIO", "n2-stress-ramp"),
        seed: env_parse("SEED", DEFAULT_SEED as u64),
        tick_rate: env_parse("TICK", TICK_RATE),
        client_count: env_parse("CLIENT_COUNT", DEFAULT_CLIENT_COUNT),
        bot_count: env_parse("BOT_COUNT", DEFAULT_BOTS as u32),
        injected_delay_cto_s_ms: env_parse("DELAY_CTOS_MS", 0.0),
        injected_delay_sto_c_ms: env_parse("DELAY_STOC_MS", 0.0),
        loss_pct: env_parse("LOSS_PCT", 0.0),
        client_index: env_parse("CLIENT_INDEX", DEFAULT_CLIENT_INDEX),
    };
    // `MAX_WINDOWS <= 0` runs forever (mirrors the web probe's `maxWindows <= 0`).
    let max_windows = match env_opt::<i64>("MAX_WINDOWS").unwrap_or(DEFAULT_MAX_WINDOWS) {
        n if n > 0 => Some(n as usize),
        _ => None,
    };
    let out_path: std::path::PathBuf = env_str("RENDER_OUT", "client-render.jsonl").into();
    println!(
        "net-bevy render probe ON: scenario={} seed={} tick={} bots={} -> {}",
        keys.scenario,
        keys.seed,
        keys.tick_rate,
        keys.bot_count,
        out_path.display()
    );
    app.add_plugins(ClientRenderPlugin {
        keys,
        out_path,
        warmup_ms: env_parse("WARMUP_MS", DEFAULT_WARMUP_MS),
        window_duration_ms: env_parse("WINDOW_MS", DEFAULT_WINDOW_MS),
        max_windows,
    });
}
