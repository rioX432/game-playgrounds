//! Wire contracts for the native authority — the Rust mirror of
//! `net/protocol/src/messages.ts`, expressed as replicon-replicated **sim**
//! components + a client→server input message.
//!
//! Design rule (Codex, verified against docs.rs for replicon 0.40.4): replicate
//! SMALL net-sim components ([`NetPosition`], [`RoleFlags`]) on `Replicated`
//! entities — NEVER the render `Transform`. The client buffers these and the
//! render layer derives `Transform` from the interpolation buffer. Replicon
//! sends only CHANGED values on `Replicated` entities, not every component every
//! tick.
//!
//! Position is kept as explicit `f32` fields (not `Vec3`) so serialization does
//! not depend on glam's optional `serialize` feature — the wire shape is owned
//! here, exactly like the thin DTOs on the web side.

use bevy::math::Vec3;
use bevy::prelude::*;
use bevy_replicon::prelude::*;
use serde::{Deserialize, Serialize};

/// Authoritative planar position of one entity (replicated). Mirrors
/// `PlayerSnapshot.pos`. `y` is carried but is always 0 in this planar sample.
#[derive(Component, Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq)]
pub struct NetPosition {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

impl NetPosition {
    pub fn from_vec3(v: Vec3) -> Self {
        Self {
            x: v.x,
            y: v.y,
            z: v.z,
        }
    }

    pub fn to_vec3(self) -> Vec3 {
        Vec3::new(self.x, self.y, self.z)
    }
}

/// Authoritative boolean-state bitfield (replicated). Mirrors
/// `PlayerSnapshot.flags` — `FLAG_GROUNDED` / `FLAG_FIRING` packed into one byte,
/// so adding a boolean state does NOT widen the wire schema.
#[derive(Component, Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq)]
pub struct RoleFlags(pub u8);

/// Client → server input for one client tick. Mirrors `PlayerInput`, minus the
/// metrics-only fields (RTT echo / client timestamp belong to #147). `seq` is
/// monotonic per client; the server rejects `seq <= last_seq` so an out-of-order
/// delivery cannot rewind authoritative state (mirrors `World.applyInput`).
#[derive(Message, Serialize, Deserialize, Clone, Copy, Debug, Default)]
pub struct InputMessage {
    /// Monotonic per-client sequence (stale-input guard).
    pub seq: u32,
    /// Desired planar move axis, each component in `[-1, 1]`.
    pub move_x: f32,
    pub move_y: f32,
    /// Pressed-button bitfield (`FLAG_FIRING`).
    pub buttons: u8,
}

/// Registers the replicated components + client message on BOTH roles. Loaded by
/// the server app, the client app, AND the headless loopback test — never the
/// render layer. Registration must happen on both ends and BEFORE the renet
/// `ConnectionConfig` is built from `RepliconChannels`, because the set of
/// registered components/messages determines the channel layout.
pub struct NetProtocolPlugin;

impl Plugin for NetProtocolPlugin {
    fn build(&self, app: &mut App) {
        app.replicate::<NetPosition>()
            .replicate::<RoleFlags>()
            // Ordered so the per-client `seq` stream cannot arrive reordered
            // (the stale-seq guard is then purely a duplicate/late-join defence).
            .add_client_message::<InputMessage>(Channel::Ordered);
    }
}
