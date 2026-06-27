//! net-bevy binary — one binary, two roles: `--server` or `--client`.
//!
//! ```bash
//! cargo run -- --server                 # headless authority on 127.0.0.1:5010
//! cargo run -- --client                 # windowed client → 127.0.0.1:5010
//! cargo run -- --client 127.0.0.1:5010  # windowed client → explicit host:port
//! ```
//!
//! The render / net-sim split is visible right here: the `--server` role loads
//! the headless `MinimalPlugins` stack (no window), while only the `--client`
//! role adds `DefaultPlugins` + `NetRenderPlugin`.

use std::net::{Ipv4Addr, SocketAddr};
use std::time::{SystemTime, UNIX_EPOCH};

use bevy::prelude::*;
use bevy_replicon::prelude::*;
use bevy_replicon_renet::RepliconRenetPlugins;

use net_bevy::client::NetClientSimPlugin;
use net_bevy::config::DEFAULT_PORT;
use net_bevy::protocol::NetProtocolPlugin;
use net_bevy::render::NetRenderPlugin;
use net_bevy::{build_server_app, start_client, start_server};

const MAX_CLIENTS: usize = 24;

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
        _ => {
            eprintln!("usage: net-bevy --server | --client [host:port]");
            std::process::exit(2);
        }
    }
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

fn run_client(server_addr: SocketAddr) {
    let mut app = App::new();
    // Windowed: DefaultPlugins (NOT the headless MinimalPlugins) so the client
    // has a window, renderer and keyboard. DefaultPlugins already includes the
    // states plugin replicon needs.
    app.add_plugins((DefaultPlugins, RepliconPlugins, RepliconRenetPlugins));
    app.add_plugins((NetProtocolPlugin, NetClientSimPlugin, NetRenderPlugin));
    start_client(&mut app, server_addr, fresh_client_id()).expect("failed to bind client socket");
    info!("net-bevy client connecting to {server_addr}");
    app.run();
}
