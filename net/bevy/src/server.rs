//! `NetServerSimPlugin` — the authoritative server logic, headless.
//!
//! Mirrors the web authority (`net/server`): on connect spawn a player, fold each
//! client's latest input, integrate at a fixed tick, and let replicon replicate
//! the changed sim components. There is NO render, NO window and NO direct socket
//! code here — the renet endpoint is inserted separately (see [`crate::transport`])
//! and `RepliconRenetPlugins` drives it. That is the render / net-sim split.
//!
//! Player state lives directly ON the `ConnectedClient` entity that the renet
//! backend spawns: replicon's `FromClient { client_id, .. }` carries a
//! [`ClientId`] whose `.entity()` IS that same entity, so an arriving input maps
//! to its player with no side table. When the backend despawns the entity on
//! disconnect, replicon propagates the despawn to clients automatically — so
//! "leave" needs no explicit teardown system.

use bevy::math::Vec2;
use bevy::prelude::*;
use bevy_replicon::prelude::*;

use crate::config::{FLAG_GROUNDED, TICK_RATE};
use crate::protocol::{InputMessage, NetPosition, RoleFlags};
use crate::sim::{flags_from_buttons, integrate, sanitize_axis};

/// The latest authoritative input folded onto a player entity. Server-only and
/// NOT replicated (the client never needs the server's raw input buffer). `seq`
/// is the monotonic per-client guard: an input with `seq <= last_seq` is dropped
/// so out-of-order UDP delivery cannot rewind state (mirrors `World.applyInput`).
#[derive(Component, Default, Clone, Copy, Debug)]
pub struct LatestInput {
    move_axis: Vec2,
    buttons: u8,
    last_seq: u32,
}

impl LatestInput {
    /// Fold one client input with the monotonic `seq` guard. The raw axis is
    /// sanitized to `[-1, 1]` here, so every caller (the N1 receive system AND the
    /// probe's conditioned receive in [`crate::probe`]) shares the exact same
    /// authoritative-state rule. Returns whether it applied (`false` = stale/dup).
    pub(crate) fn fold_input(&mut self, seq: u32, raw_axis: Vec2, buttons: u8) -> bool {
        if seq <= self.last_seq {
            return false; // stale / duplicate
        }
        self.last_seq = seq;
        self.move_axis = sanitize_axis(raw_axis);
        self.buttons = buttons;
        true
    }

    /// Drive this entity directly from a server-internal bot (no network `seq`):
    /// bots always produce fresh input, so there is no stale-`seq` guard. The axis
    /// is sanitized identically to a network input.
    pub(crate) fn drive(&mut self, raw_axis: Vec2, buttons: u8) {
        self.move_axis = sanitize_axis(raw_axis);
        self.buttons = buttons;
    }
}

/// Authoritative server simulation. Add to the server app only.
pub struct NetServerSimPlugin;

impl Plugin for NetServerSimPlugin {
    fn build(&self, app: &mut App) {
        // Fixed authoritative tick (N1 comparability — same 20 Hz as the web server).
        app.insert_resource(Time::<Fixed>::from_hz(TICK_RATE));
        // Spawn players on connect + read inputs every frame (reliable drain);
        // integrate on the fixed tick. `Added<ConnectedClient>` is used (not an
        // observer) so the accessor surface is the stable query-filter API; the
        // backend spawns `ConnectedClient` in `PreUpdate`, so `Update` catches it
        // the same frame.
        app.add_systems(Update, (attach_players, receive_input));
        app.add_systems(FixedUpdate, server_step);
    }
}

/// Make a freshly connected client an authoritative, replicated player at the
/// origin. The replicated components (`NetPosition`, `RoleFlags`) plus the
/// `Replicated` marker are attached to the backend's `ConnectedClient` entity.
pub(crate) fn attach_players(mut commands: Commands, joined: Query<Entity, Added<ConnectedClient>>) {
    for entity in &joined {
        commands.entity(entity).insert((
            Replicated,
            NetPosition::default(), // origin
            RoleFlags(FLAG_GROUNDED),
            LatestInput::default(),
        ));
    }
}

/// Fold each arriving client input onto its player entity (latest-wins, with the
/// monotonic `seq` guard). `client_id.entity()` resolves the player directly.
fn receive_input(
    mut reader: MessageReader<FromClient<InputMessage>>,
    mut players: Query<&mut LatestInput>,
) {
    for FromClient { client_id, message } in reader.read() {
        let Some(entity) = client_id.entity() else {
            continue; // local-listen `Server` id has no player entity in this split.
        };
        let Ok(mut latest) = players.get_mut(entity) else {
            continue; // input before the player bundle is attached — drop it.
        };
        latest.fold_input(
            message.seq,
            Vec2::new(message.move_x, message.move_y),
            message.buttons,
        );
    }
}

/// Advance every player one fixed step and refresh its flags. Components are
/// written via `set_if_neq` so an idle player produces NO change and therefore NO
/// replication traffic — replicon sends only changed values (the delta property
/// the chapter is demonstrating).
pub(crate) fn server_step(
    time: Res<Time<Fixed>>,
    mut players: Query<(&LatestInput, &mut NetPosition, &mut RoleFlags)>,
) {
    let dt = time.delta_secs();
    for (input, mut pos, mut flags) in &mut players {
        let next = NetPosition::from_vec3(integrate(pos.to_vec3(), input.move_axis, dt));
        pos.set_if_neq(next);
        flags.set_if_neq(RoleFlags(flags_from_buttons(input.buttons)));
    }
}
