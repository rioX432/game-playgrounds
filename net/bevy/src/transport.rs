//! renet (UDP) endpoint construction for the server and client roles.
//!
//! Kept apart from the sim plugins so the simulation stays transport-free and
//! headless-testable. `RepliconRenetPlugins` adds the plugins that DRIVE the
//! sockets each frame; it does NOT create the endpoints — these helpers build the
//! `RenetServer`/`RenetClient` + netcode transports that the caller inserts as
//! resources (the loopback test and the `--server`/`--client` binary both use
//! them). Verified against renet 2.0.0 / renet_netcode 2.0.0 (the versions
//! `bevy_renet 4.0` resolves) and the `bevy_replicon_renet` 0.16 example.
//!
//! The `ConnectionConfig` channel layout is derived from `RepliconChannels`,
//! which is only complete AFTER all replicated components + messages are
//! registered — so callers must build endpoints post-`NetProtocolPlugin`.

use std::io;
use std::net::{Ipv4Addr, SocketAddr, UdpSocket};
use std::time::{Duration, SystemTime};

use bevy_replicon::prelude::RepliconChannels;
use bevy_replicon_renet::netcode::{
    ClientAuthentication, NetcodeClientTransport, NetcodeServerTransport, ServerAuthentication,
    ServerConfig,
};
use bevy_replicon_renet::renet::ConnectionConfig;
// The renet endpoints inserted as Bevy resources are bevy_renet's Resource
// WRAPPER newtypes (re-exported at the crate root via `pub use bevy_renet::*`),
// NOT the bare `renet::RenetServer`/`RenetClient` (those don't impl `Resource`).
use bevy_replicon_renet::{RenetChannelsExt, RenetClient, RenetServer};

use crate::config::PROTOCOL_ID;

/// Wall-clock since the Unix epoch — what netcode uses to stamp tokens/timeouts.
fn epoch_now() -> Duration {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .expect("system clock is before the Unix epoch")
}

/// Build the `ConnectionConfig` channel layout from replicon's registered
/// channels. Both ends must build it from the SAME registered protocol or the
/// channel ids won't line up.
fn connection_config(channels: &RepliconChannels) -> ConnectionConfig {
    ConnectionConfig {
        server_channels_config: channels.server_configs(),
        client_channels_config: channels.client_configs(),
        ..Default::default()
    }
}

/// Bind a UDP server socket and build its renet endpoint. Pass `127.0.0.1:0` to
/// let the OS assign a free port (the loopback test reads the chosen port from
/// the returned [`SocketAddr`]); pass a fixed port for the standalone binary.
pub fn bind_server(
    channels: &RepliconChannels,
    bind_addr: SocketAddr,
    max_clients: usize,
) -> io::Result<(RenetServer, NetcodeServerTransport, SocketAddr)> {
    let socket = UdpSocket::bind(bind_addr)?;
    // The OS-assigned address is both what the client dials and the address the
    // netcode `ServerConfig` advertises.
    let server_addr = socket.local_addr()?;
    let server_config = ServerConfig {
        current_time: epoch_now(),
        max_clients,
        protocol_id: PROTOCOL_ID,
        public_addresses: vec![server_addr],
        authentication: ServerAuthentication::Unsecure,
    };
    let transport = NetcodeServerTransport::new(server_config, socket)?;
    let server = RenetServer::new(connection_config(channels));
    Ok((server, transport, server_addr))
}

/// Bind an ephemeral UDP client socket and build its renet endpoint pointed at
/// `server_addr`. `protocol_id` MUST match the server (default-`ProtocolCheck`
/// auth then auto-authorizes the client, since both ends are the same binary).
pub fn connect_client(
    channels: &RepliconChannels,
    server_addr: SocketAddr,
    client_id: u64,
) -> io::Result<(RenetClient, NetcodeClientTransport)> {
    let socket = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0))?;
    let authentication = ClientAuthentication::Unsecure {
        protocol_id: PROTOCOL_ID,
        client_id,
        server_addr,
        user_data: None,
    };
    let transport = NetcodeClientTransport::new(epoch_now(), authentication, socket)
        .map_err(io::Error::other)?;
    let client = RenetClient::new(connection_config(channels));
    Ok((client, transport))
}
