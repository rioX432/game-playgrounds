//! `NetClientSimPlugin` — the client net-sim, headless.
//!
//! Mirrors the web client (`net/web-three/src/net`): send thin input frames, and
//! fold the replicated authoritative state into a per-entity interpolation buffer
//! that the render layer samples `INTERP_TICKS` behind real time. It owns NO
//! render or socket code (the render layer writes `Transform` FROM the buffer;
//! `RepliconRenetPlugins` drives the socket) — the render / net-sim split.
//!
//! CRITICAL (Codex): the render `Transform` is never replicated nor smoothed.
//! Replicon mutates the small [`NetPosition`] sim component; a change-detection
//! system appends each mutation to [`InterpTrack`]; render reads the interpolated
//! value. See [`crate::interpolation`].

use bevy::prelude::*;
use bevy_replicon::prelude::*;

use crate::config::{MAX_SAMPLES, TICK_RATE};
use crate::interpolation::InterpBuffer;
use crate::protocol::{InputMessage, NetPosition, RoleFlags};

/// The client's current control intent, owned by the render/input layer (or a
/// test). This is the ONLY client-authored state — authoritative simulation is
/// the server's (no client-side prediction; this sample is low-twitch by design).
#[derive(Resource, Default, Clone, Copy, Debug)]
pub struct ClientInput {
    /// Planar move axis, each component in `[-1, 1]`.
    pub move_x: f32,
    pub move_y: f32,
    /// Pressed-button bitfield (`FLAG_FIRING`).
    pub buttons: u8,
}

/// Per-entity interpolation buffer attached to each replicated entity on the
/// client. The render layer samples it at `now - interp_delay`.
#[derive(Component)]
pub struct InterpTrack(pub InterpBuffer);

/// Client net-sim. Add to the client app only.
pub struct NetClientSimPlugin;

impl Plugin for NetClientSimPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<ClientInput>();
        app.insert_resource(Time::<Fixed>::from_hz(TICK_RATE));
        // Send input on the fixed cadence, but only while actually connected.
        app.add_systems(
            FixedUpdate,
            send_input.run_if(in_state(ClientState::Connected)),
        );
        // Fold replicated mutations into interpolation buffers every frame.
        app.add_systems(Update, ingest_samples);
    }
}

/// Send one thin input frame. `seq` is monotonic per client (a `Local`), echoing
/// the web client's per-client sequence; replicon forwards the message to the
/// server, which reads it as `FromClient<InputMessage>`.
fn send_input(
    input: Res<ClientInput>,
    mut seq: Local<u32>,
    mut writer: MessageWriter<InputMessage>,
) {
    *seq += 1;
    writer.write(InputMessage {
        seq: *seq,
        move_x: input.move_x,
        move_y: input.move_y,
        buttons: input.buttons,
    });
}

/// Append every replicated authoritative mutation to the entity's interpolation
/// buffer, timestamped with the local clock (the sample times the render layer
/// later interpolates between). The buffer is created lazily — pre-loaded with
/// the first sample — when an entity first replicates, so no sample is lost.
fn ingest_samples(
    mut commands: Commands,
    time: Res<Time>,
    mut tracked: Query<(Entity, Ref<NetPosition>, &RoleFlags, Option<&mut InterpTrack>)>,
) {
    let now = time.elapsed_secs_f64();
    for (entity, pos, flags, track) in &mut tracked {
        // Only push when replication actually changed the authoritative value
        // (mirrors replicon's changed-only replication).
        if !pos.is_changed() {
            continue;
        }
        match track {
            Some(mut track) => track.0.push(now, pos.to_vec3(), flags.0),
            None => {
                let mut buffer = InterpBuffer::new(MAX_SAMPLES);
                buffer.push(now, pos.to_vec3(), flags.0);
                commands.entity(entity).insert(InterpTrack(buffer));
            }
        }
    }
}
