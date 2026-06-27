//! net-bevy — Bevy 0.18 native server-authoritative replication (N1).
//!
//! The native authority + client of the net/ chapter, the Rust mirror of the
//! web N1 sample (`net/web-three`, `net/server`): an authoritative server applies
//! input and replicates a thin sim state; clients interpolate it for render.
//!
//! ## Render / net-sim separation (an acceptance criterion)
//! The crate is split so the simulation + networking is **headless-testable** and
//! the render layer is the ONLY part that needs a GPU/window:
//! - [`protocol`] — replicated sim components ([`protocol::NetPosition`],
//!   [`protocol::RoleFlags`]) + the client→server [`protocol::InputMessage`].
//! - [`sim`] — pure authoritative integration (no `App`, no socket, no window).
//! - [`interpolation`] — pure per-entity snapshot interpolation buffer.
//! - [`server`] — `NetServerSimPlugin`: connection handling, spawn players,
//!   apply input, integrate (authoritative).
//! - [`client`] — `NetClientSimPlugin`: send input, fold replicated state into
//!   interpolation buffers.
//! - [`transport`] — renet endpoint (UDP) setup for server / client.
//! - [`render`] — `NetRenderPlugin`: `DefaultPlugins`, meshes, camera, keyboard.
//!   Added ONLY by the binary; never loaded by tests.
//!
//! Headless tests load only `MinimalPlugins` + `StatesPlugin` + `Replicon*` +
//! the sim/protocol/interpolation plugins — see `tests/net_loopback.rs`.

use std::io;
use std::net::SocketAddr;

use bevy::prelude::*;
use bevy::state::app::StatesPlugin;
use bevy_replicon::prelude::*;
use bevy_replicon_renet::RepliconRenetPlugins;

pub mod client;
pub mod config;
pub mod interpolation;
pub mod protocol;
pub mod render;
pub mod server;
pub mod sim;

/// The shared headless plugin set every net app (server, client, test) loads:
/// the engine core with NO window/GPU, Bevy states (replicon needs them), the
/// replication core, and the renet backend. The render layer is added ONLY by
/// the binary, never here — that is the render / net-sim split.
///
/// `RepliconPlugins.set(ServerPlugin::new(PostUpdate))` is used so a replication
/// message is built on EVERY `app.update()` — the default `FixedPostUpdate` would
/// only send on fixed ticks, making the loopback test order-sensitive.
pub fn add_headless_net_plugins(app: &mut App) {
    app.add_plugins((
        MinimalPlugins,
        StatesPlugin,
        RepliconPlugins.set(ServerPlugin::new(PostUpdate)),
        RepliconRenetPlugins,
    ));
}

/// A headless authoritative-server app: shared net plugins + protocol + server
/// sim. The renet endpoint is NOT bound yet — call [`start_server`] once, after
/// the protocol is registered, so the channel layout is complete.
pub fn build_server_app() -> App {
    let mut app = App::new();
    add_headless_net_plugins(&mut app);
    app.add_plugins((protocol::NetProtocolPlugin, server::NetServerSimPlugin));
    app
}

/// A headless client app: shared net plugins + protocol + client sim (no render).
/// The binary adds [`render::NetRenderPlugin`] on top; tests do not.
pub fn build_client_app() -> App {
    let mut app = App::new();
    add_headless_net_plugins(&mut app);
    app.add_plugins((protocol::NetProtocolPlugin, client::NetClientSimPlugin));
    app
}

/// Bind the server's renet endpoint and insert it as resources. Returns the
/// actually-bound address (meaningful when `bind_addr` used port 0). Must be
/// called AFTER the protocol plugin so `RepliconChannels` is fully populated.
pub fn start_server(
    app: &mut App,
    bind_addr: SocketAddr,
    max_clients: usize,
) -> io::Result<SocketAddr> {
    // Borrow channels only long enough to build the endpoint (no Clone needed).
    let (server, transport, addr) = {
        let channels = app.world().resource::<RepliconChannels>();
        transport::bind_server(channels, bind_addr, max_clients)?
    };
    app.insert_resource(server);
    app.insert_resource(transport);
    Ok(addr)
}

/// Bind the client's renet endpoint (pointed at `server_addr`) and insert it as
/// resources. Must be called AFTER the protocol plugin.
pub fn start_client(app: &mut App, server_addr: SocketAddr, client_id: u64) -> io::Result<()> {
    let (client, transport) = {
        let channels = app.world().resource::<RepliconChannels>();
        transport::connect_client(channels, server_addr, client_id)?
    };
    app.insert_resource(client);
    app.insert_resource(transport);
    Ok(())
}

pub mod transport;

#[cfg(test)]
mod tests {
    use super::*;

    /// Smoke test inherited from the #145 spike: the replicon + renet plugin
    /// groups still construct and tick on Bevy 0.18 with the N1 protocol added.
    #[test]
    fn headless_app_builds_and_ticks() {
        let mut app = build_server_app();
        app.update();
    }
}
