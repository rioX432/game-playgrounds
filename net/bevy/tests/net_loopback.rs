//! Real-localhost-UDP loopback test — the key deliverable of issue #146.
//!
//! Two SEPARATE Bevy `App`s in ONE process (a server app and a client app), each
//! with its own renet endpoint bound to `127.0.0.1`, exchanging real UDP packets.
//! It drives the full N1 lifecycle and asserts at each phase:
//!   join → input → snapshot (position + role-flags state) → leave.
//!
//! Design constraints baked in (Codex):
//! - Server and client renet resources live in DIFFERENT apps — never both in one
//!   (`bevy_replicon_renet` warns that creates a replication loop).
//! - NO `DefaultPlugins` and NO window: the apps are the headless
//!   `MinimalPlugins + StatesPlugin + Replicon* + sim/protocol/interp` stack via
//!   `build_server_app` / `build_client_app`. `NetRenderPlugin` is never loaded.
//! - BOUNDED pump loop with a wall-clock deadline (no upstream infinite connect
//!   loop); a short real sleep each iteration lets the OS deliver UDP packets.

use std::net::{Ipv4Addr, SocketAddr};
use std::thread::sleep;
use std::time::{Duration, Instant};

use bevy::prelude::*;
use bevy_replicon::prelude::*;
use bevy_replicon_renet::RenetClient;

use net_bevy::client::{ClientInput, InterpTrack};
use net_bevy::config::{FLAG_FIRING, FLAG_GROUNDED};
use net_bevy::protocol::{NetPosition, RoleFlags};
use net_bevy::{build_client_app, build_server_app, start_client, start_server};

/// Real sleep between pump iterations — gives the localhost UDP stack time to
/// deliver, and advances `Time<Real>` (which drives the renet timers).
const STEP: Duration = Duration::from_millis(15);
/// Upper bound on any single wait phase. The loop exits as soon as its condition
/// holds, so a healthy run is far faster; this only bounds a failure.
const DEADLINE: Duration = Duration::from_secs(10);
const CLIENT_ID: u64 = 1;
const MAX_CLIENTS: usize = 8;

/// One synchronized step of both apps + a real sleep for UDP delivery.
fn pump(server: &mut App, client: &mut App) {
    server.update();
    client.update();
    sleep(STEP);
}

/// Pump both apps until `cond` holds or the deadline elapses. Returns whether the
/// condition was met (so the caller asserts with a clear message).
fn pump_until(
    server: &mut App,
    client: &mut App,
    mut cond: impl FnMut(&mut App, &mut App) -> bool,
) -> bool {
    let start = Instant::now();
    while start.elapsed() < DEADLINE {
        if cond(server, client) {
            return true;
        }
        pump(server, client);
    }
    cond(server, client)
}

/// Count server-side connected clients (entities the renet backend spawned).
fn connected_clients(server: &mut App) -> usize {
    let mut q = server
        .world_mut()
        .query_filtered::<Entity, With<ConnectedClient>>();
    q.iter(server.world()).count()
}

/// The single replicated player's state as seen on the CLIENT, if present.
fn client_player_state(client: &mut App) -> Option<(NetPosition, RoleFlags)> {
    let mut q = client.world_mut().query::<(&NetPosition, &RoleFlags)>();
    q.iter(client.world()).next().map(|(p, f)| (*p, *f))
}

#[test]
fn loopback_join_input_snapshot_leave() {
    // --- Arrange: two endpoints on 127.0.0.1, server on an OS-assigned port. ---
    let mut server = build_server_app();
    let bind: SocketAddr = (Ipv4Addr::LOCALHOST, 0).into();
    let server_addr = start_server(&mut server, bind, MAX_CLIENTS).expect("bind server");

    let mut client = build_client_app();
    start_client(&mut client, server_addr, CLIENT_ID).expect("bind client");

    // Manually-driven apps (we call `update()` in a loop, not `run()`) must run
    // `finish()` + `cleanup()` themselves. Replicon sets up its per-channel
    // receive buffers in `ServerPlugin::finish()` — skip this and the first
    // receive panics with "server should have a receive channel".
    for app in [&mut server, &mut client] {
        app.finish();
        app.cleanup();
    }

    // --- Phase JOIN: the client connects and the server registers it. ---
    let joined = pump_until(&mut server, &mut client, |s, c| {
        client_connected(c) && connected_clients(s) == 1
    });
    assert!(
        joined,
        "client did not reach Connected + server ConnectedClient within {DEADLINE:?}"
    );

    // The authoritative player must replicate to the client at the origin.
    let replicated = pump_until(&mut server, &mut client, |_s, c| {
        client_player_state(c).is_some()
    });
    assert!(replicated, "player entity did not replicate to the client");
    let (start_pos, start_flags) = client_player_state(&mut client).unwrap();
    assert_eq!(start_pos, NetPosition::default(), "player starts at origin");
    assert_eq!(
        start_flags.0 & FLAG_GROUNDED,
        FLAG_GROUNDED,
        "grounded flag replicates from the first snapshot"
    );

    // --- Phase INPUT → SNAPSHOT: drive +x movement and the firing flag. ---
    {
        let mut input = client.world_mut().resource_mut::<ClientInput>();
        input.move_x = 1.0;
        input.move_y = 0.0;
        input.buttons = FLAG_FIRING;
    }

    // Authoritative position must advance on +x and replicate back.
    let moved = pump_until(&mut server, &mut client, |_s, c| {
        client_player_state(c).is_some_and(|(p, _)| p.x > 1.0)
    });
    let (moved_pos, moved_flags) = client_player_state(&mut client).unwrap();
    assert!(
        moved,
        "replicated position did not advance on +x (got {moved_pos:?})"
    );
    assert_eq!(moved_pos.z, 0.0, "no drift on the undriven axis");

    // The role/tag flag state must round-trip through the authoritative snapshot.
    assert_eq!(
        moved_flags.0 & FLAG_FIRING,
        FLAG_FIRING,
        "firing flag did not replicate (flags={moved_flags:?})"
    );

    // Client interpolation must have buffered the replicated samples and produce
    // an interpolated pose (the render layer reads exactly this).
    let interp_pos = sample_interpolated(&mut client);
    assert!(
        interp_pos.is_some_and(|p| p.x > 0.0),
        "interpolation buffer did not yield a forward-moved pose (got {interp_pos:?})"
    );

    // --- Phase LEAVE: client-initiated disconnect; server drops the client. ---
    client
        .world_mut()
        .resource_mut::<RenetClient>()
        .disconnect();
    // Pump a few frames so the disconnect packet is sent and processed; state may
    // settle one frame later (Codex).
    let left = pump_until(&mut server, &mut client, |s, _c| connected_clients(s) == 0);
    assert!(
        left,
        "server still shows a connected client after disconnect"
    );
}

/// Whether the client replicon state machine reports a live connection.
fn client_connected(client: &App) -> bool {
    client
        .world()
        .get_resource::<State<ClientState>>()
        .is_some_and(|s| *s.get() == ClientState::Connected)
}

/// Sample the client's interpolation buffer at its freshest time (proves the
/// render-facing interpolation path produced a pose from replicated samples).
fn sample_interpolated(client: &mut App) -> Option<Vec3> {
    let mut q = client.world_mut().query::<&InterpTrack>();
    let track = q.iter(client.world()).next()?;
    let t = track.0.latest_time()?;
    track.0.sample_at(t).map(|r| r.pos)
}
