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
#[allow(clippy::type_complexity)] // an inherently-shaped ECS change-detection query
fn ingest_samples(
    mut commands: Commands,
    time: Res<Time>,
    mut tracked: Query<(Entity, Ref<NetPosition>, Ref<RoleFlags>, Option<&mut InterpTrack>)>,
) {
    // HONEST-FEEL NOTE (core value): unlike the web client, which interpolates at
    // SERVER time (snapshots carry `serverTimeMs` and the client anchors clocks
    // off the welcome), this stamps each sample with LOCAL ARRIVAL time. Replicon
    // mutations carry no server timestamp, so the simplification trades exact
    // clock-domain alignment for not having to replicate a tick clock — at the
    // cost of folding network/arrival jitter into the sample spacing. Adequate for
    // N1; a tighter mirror would replicate a server tick and interpolate on it.
    let now = time.elapsed_secs_f64();
    for (entity, pos, flags, track) in &mut tracked {
        // Push when EITHER replicated component changed. The server writes
        // `NetPosition` and `RoleFlags` independently via `set_if_neq`, so a
        // stationary player toggling the firing flag mutates ONLY `RoleFlags`;
        // gating on position alone would drop that flag update and leave the
        // render layer showing stale firing state.
        if !pos.is_changed() && !flags.is_changed() {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build_client_app;
    use crate::config::{FLAG_FIRING, FLAG_GROUNDED};

    /// Regression: a flag-only authoritative change (player fires while standing
    /// still — `RoleFlags` mutates but `NetPosition` does not) must still reach the
    /// interpolation buffer, so the render layer sees the new firing state. This is
    /// the headless mirror of the loopback test's coupled move+fire path, exercised
    /// in isolation so the flag-only branch can't silently regress.
    #[test]
    fn flag_only_change_reaches_interp_buffer() {
        let mut app = build_client_app();
        // Manually-driven app: replicon sizes its channels in `finish()`.
        app.finish();
        app.cleanup();

        // Stand in for a just-replicated player (grounded, at the origin).
        let player = app
            .world_mut()
            .spawn((NetPosition::default(), RoleFlags(FLAG_GROUNDED)))
            .id();
        app.update(); // ingest_samples attaches InterpTrack with the first sample.

        // Mutate ONLY the flags — exactly what the server replicates for a
        // stationary firing player (no NetPosition change).
        app.world_mut()
            .get_mut::<RoleFlags>(player)
            .expect("RoleFlags present")
            .0 = FLAG_GROUNDED | FLAG_FIRING;
        app.update();

        let track = app
            .world()
            .get::<InterpTrack>(player)
            .expect("InterpTrack attached");
        let latest = track.0.latest_time().expect("a sample was buffered");
        let sample = track.0.sample_at(latest).expect("sampleable");
        assert_eq!(
            sample.flags & FLAG_FIRING,
            FLAG_FIRING,
            "flag-only update must be ingested even with no position change"
        );
    }
}
