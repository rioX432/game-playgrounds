//! N2 load probe (#147) — the Rust counterpart of the web N2 probe (#144).
//!
//! Boots a headless authoritative server + N real-UDP probe clients in ONE
//! process, ramps server-internal bots to scale the sync-entity count, injects
//! app-level bidirectional impairment, and emits one schema-valid `MetricsSample`
//! per scenario stage to `metrics.jsonl` — the SAME #140 schema the web probe
//! writes, so #148 can diff Web vs Bevy apples-to-apples.
//!
//! ## What is measured, and how honestly (Core Value #1)
//!
//! | metric | source | web-parity |
//! |--------|--------|-----------|
//! | `serverTickSimMs` | timed `FixedUpdate` sim set (bot drive + integrate) | TRUE parity |
//! | `serverTickSerializeMs` | timed replicon `ServerSystems::Send` set | honest split (see below) |
//! | `serverTickSendMs` | timed `SendPackets` + renet `RenetSend` flush | honest split |
//! | `bytesUp/DownPerSec` | postcard-sized app payload (replicon's native encoding) | parity of *definition*; encoding differs (postcard vs JSON) |
//! | `transportBytesPerSec` | renet `ConnectedClientStats` (real wire bytes) | BETTER than web (measured, not estimated) |
//! | `rttP50/P95Ms` | renet transport RTT | documented GAP: excludes app-injected delay |
//! | `snapshotAgeMs` | probe-client interp-buffer depth | TRUE parity |
//! | `injectedDelay*`, `lossPct` | scenario knobs (`lossPct = max(up,down)`) | TRUE parity |
//!
//! HONEST SPLIT (serialize vs send): replicon OWNS replication, but exposes two
//! ordered system sets — `ServerSystems::Send` builds + postcard-serializes the
//! replication messages into `ServerMessages`, then `SendPackets` + `RenetSend`
//! copy to renet and flush the socket. Timing each set is the cleanest honest
//! decomposition the backend allows; it is NOT the same internal boundary as the
//! web server's hand-rolled `buildSnapshot` vs `client.send`, but it is measured,
//! not invented. See `net/bevy/CLAUDE.md` for the full caveat list.

use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::thread::sleep;
use std::collections::HashMap;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use bevy::prelude::*;
use bevy::state::app::StatesPlugin;
use bevy_replicon::prelude::*;
use bevy_replicon_renet::RenetSend;

use crate::bots::{drive_bots, ramp_bots, BotRng, BotTarget};
use crate::client::{send_input, ClientInput, InterpTrack};
use crate::conditioner::{Conditioner, LinkConfig};
use crate::config::{MAX_SAMPLES, MAX_TICK_RATE, MIN_TICK_RATE};
use crate::interpolation::InterpBuffer;
use crate::metrics::{MetricsAccumulator, MetricsSample, MetricsWriter, SampleContext};
use crate::protocol::{InputMessage, NetPosition, RoleFlags};
use crate::rng::Rng;
use crate::scenario::{ScenarioDef, Stage};
use crate::server::{attach_players, server_step, LatestInput};
use crate::{add_replication_plugins, start_client, start_server};

/// Max probe clients a probe server accepts (well above the 2-client default).
const MAX_CLIENTS: usize = 32;
/// Offsets deriving the loss-draw seeds from the run seed. Bot motion uses its own
/// stream (`BotRng`), so it stays reproducible regardless of loss-draw timing
/// (mirrors the web `SHIM_SEED_OFFSET`). Uplink and downlink use DISTINCT offsets
/// so up vs down loss draws are independent, not the same sequence; each probe
/// client additionally offsets by its index (see `boot_segment`) so two clients do
/// not drop the same-indexed snapshots. (golden-ratio / xxhash constants.)
const UPLINK_SEED_OFFSET: u32 = 0x9e37_79b9;
const DOWNLINK_SEED_OFFSET: u32 = 0x85eb_ca6b;
/// Upper bound on the connect handshake wait.
const CONNECT_DEADLINE: Duration = Duration::from_secs(5);

/// Clamp a requested tick rate into the supported band (mirrors the web room's
/// `clampTick`); the clamped value is what the app runs AND what the sample records.
pub fn clamp_tick(hz: f64) -> f64 {
    hz.clamp(MIN_TICK_RATE, MAX_TICK_RATE)
}

// --- Server measurement resources ---

/// One client→server input held by the uplink conditioner: the player entity, the
/// network `seq`, the raw move axis, and the buttons bitfield.
type UplinkItem = (Entity, u32, Vec2, u8);

/// The server-side uplink conditioner (client→server impairment). Wraps the input
/// fold, mirroring the web `shim.up` around `world.applyInput`.
#[derive(Resource)]
struct UplinkConditioner(Conditioner<UplinkItem>);

/// Times the `FixedUpdate` sim set (`serverTickSimMs`).
#[derive(Resource, Default)]
struct SimTimer(Option<Instant>);

/// Times the replicon replication path in `PostUpdate`: serialize (`Send` set) and
/// send (`SendPackets` + renet flush). See the module doc's honest-split note.
#[derive(Resource, Default)]
struct ReplicationTimer {
    serialize_start: Option<Instant>,
    serialize_ms: f64,
    send_start: Option<Instant>,
}

/// The timed authoritative sim (bot drive + integrate). Bracketed by [`sim_begin`]
/// / [`sim_end`] so its wall cost becomes `serverTickSimMs`.
#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
struct ProbeSimSet;

/// Postcard byte length of a serializable value (replicon's native encoding), or 0
/// if it somehow fails to serialize (it cannot for these plain structs).
fn postcard_len<T: serde::Serialize>(v: &T) -> f64 {
    postcard::to_allocvec(v).map(|b| b.len()).unwrap_or(0) as f64
}

/// Server measurement + load plugin. Reuses the N1 authoritative systems
/// ([`attach_players`], [`server_step`]) and adds bots, the conditioned uplink, and
/// the per-tick timing/byte/stat instrumentation.
struct ProbeServerPlugin {
    tick_rate: f64,
    seed: u32,
    uplink: LinkConfig,
}

impl Plugin for ProbeServerPlugin {
    fn build(&self, app: &mut App) {
        app.insert_resource(Time::<Fixed>::from_hz(clamp_tick(self.tick_rate)));
        app.insert_resource(MetricsAccumulator::default());
        app.insert_resource(BotTarget(0));
        app.insert_resource(BotRng(Rng::new(self.seed)));
        app.insert_resource(UplinkConditioner(Conditioner::new(
            self.uplink,
            // Dedicated loss-draw stream, distinct from bot motion (BotRng) and
            // from the downlink stream (distinct offset).
            Rng::new(self.seed.wrapping_add(UPLINK_SEED_OFFSET)),
        )));
        app.init_resource::<SimTimer>();
        app.init_resource::<ReplicationTimer>();

        app.add_systems(
            Update,
            (attach_players, ramp_bots, conditioned_receive_input, sample_transport_stats),
        );
        app.add_systems(
            FixedUpdate,
            (
                sim_begin,
                // `.chain()` INSIDE the set too: drive_bots must write each bot's
                // input BEFORE server_step integrates it. They conflict on
                // `LatestInput` (`&mut` vs `&`), so without an explicit order Bevy
                // would serialize them in an unspecified (build/thread-dependent)
                // order — silently varying bot motion and breaking seed repro.
                (drive_bots, server_step).chain().in_set(ProbeSimSet),
                sim_end,
                measure_down_bytes,
            )
                .chain(),
        );
        app.add_systems(
            PostUpdate,
            (
                rep_serialize_begin.before(ServerSystems::Send),
                rep_serialize_mid
                    .after(ServerSystems::Send)
                    .before(ServerSystems::SendPackets),
                rep_send_end.after(RenetSend),
            ),
        );
    }
}

/// Fold conditioned client inputs. Offered bytes are counted BEFORE the uplink
/// conditioner may drop them (mirrors the web `recordUp`); accepted inputs are
/// released by the conditioner (immediately if no delay) and folded with the
/// monotonic `seq` guard.
fn conditioned_receive_input(
    time: Res<Time>,
    mut reader: MessageReader<FromClient<InputMessage>>,
    mut cond: ResMut<UplinkConditioner>,
    mut acc: ResMut<MetricsAccumulator>,
    mut players: Query<&mut LatestInput>,
) {
    let now = time.elapsed_secs_f64();
    for FromClient { client_id, message } in reader.read() {
        let Some(entity) = client_id.entity() else {
            continue; // local-listen Server id has no player entity in this split.
        };
        acc.record_up(postcard_len(message));
        cond.0.offer(
            now,
            (entity, message.seq, Vec2::new(message.move_x, message.move_y), message.buttons),
        );
    }
    for (entity, seq, axis, buttons) in cond.0.drain_due(now) {
        if let Ok(mut latest) = players.get_mut(entity) {
            latest.fold_input(seq, axis, buttons);
        }
    }
}

fn sim_begin(mut timer: ResMut<SimTimer>) {
    timer.0 = Some(Instant::now());
}

fn sim_end(mut timer: ResMut<SimTimer>, mut acc: ResMut<MetricsAccumulator>) {
    if let Some(start) = timer.0.take() {
        acc.record_sim_ms(start.elapsed().as_secs_f64() * 1000.0);
    }
}

/// Count app-payload downlink bytes: serialize the full set of replicated sim
/// components (every player + bot) once per tick and charge it to every connected
/// client — the SAME "full snapshot per tick per client" definition the web server
/// uses in `GameRoom.tick` (replicon's on-wire delta efficiency is captured
/// separately in `transportBytesPerSec`).
fn measure_down_bytes(
    mut acc: ResMut<MetricsAccumulator>,
    clients: Query<(), With<ConnectedClient>>,
    entities: Query<(&NetPosition, &RoleFlags)>,
) {
    let client_count = clients.iter().count();
    if client_count == 0 {
        return;
    }
    let snapshot: Vec<(NetPosition, RoleFlags)> = entities.iter().map(|(p, f)| (*p, *f)).collect();
    let bytes = postcard_len(&snapshot);
    acc.record_down(bytes * client_count as f64);
}

/// Sample renet's per-client transport stats each update: actual wire bytes/sec
/// (both directions, summed) and transport RTT (s → ms). Populated by
/// `bevy_replicon_renet` from `RenetServer::network_info`.
fn sample_transport_stats(
    mut acc: ResMut<MetricsAccumulator>,
    stats: Query<&ConnectedClientStats>,
) {
    let mut bps = 0.0;
    for s in &stats {
        bps += s.sent_bps + s.received_bps;
        acc.record_rtt(s.rtt * 1000.0);
    }
    acc.record_transport_bps(bps);
}

fn rep_serialize_begin(mut timer: ResMut<ReplicationTimer>) {
    timer.serialize_start = Some(Instant::now());
}

fn rep_serialize_mid(mut timer: ResMut<ReplicationTimer>) {
    if let Some(start) = timer.serialize_start.take() {
        timer.serialize_ms = start.elapsed().as_secs_f64() * 1000.0;
    }
    timer.send_start = Some(Instant::now());
}

fn rep_send_end(mut timer: ResMut<ReplicationTimer>, mut acc: ResMut<MetricsAccumulator>) {
    let send_ms = timer
        .send_start
        .take()
        .map(|s| s.elapsed().as_secs_f64() * 1000.0)
        .unwrap_or(0.0);
    acc.record_replication_ms(timer.serialize_ms, send_ms);
    timer.serialize_ms = 0.0;
}

// --- Probe client (conditioned downlink) ---

/// One server→client replicated mutation held by the downlink conditioner: the
/// entity, the new pos + flags, and the LOCAL capture time. The capture time is
/// what the interp buffer is timestamped with, so an injected downlink delay
/// correctly inflates `snapshotAge` (the fold happens later but the sample is
/// dated when it actually arrived).
type DownlinkItem = (Entity, Vec3, u8, f64);

/// The probe client's downlink conditioner (server→client impairment). Conditions
/// the FOLD of replicated mutations into the interp buffer — replicon owns the
/// send, so this mirrors the EFFECT of the web `shim.down` on the receive side.
#[derive(Resource)]
struct DownlinkConditioner(Conditioner<DownlinkItem>);

/// Probe client plugin: send the same input frame as the N1 client, but ingest
/// replicated state through the downlink conditioner instead of immediately.
struct ProbeClientPlugin {
    tick_rate: f64,
    downlink: LinkConfig,
    seed: u32,
}

impl Plugin for ProbeClientPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<ClientInput>();
        app.insert_resource(Time::<Fixed>::from_hz(clamp_tick(self.tick_rate)));
        app.insert_resource(DownlinkConditioner(Conditioner::new(
            self.downlink,
            // `self.seed` is already per-client (run seed + client index, see
            // boot_segment); the downlink offset makes it independent of uplink.
            Rng::new(self.seed.wrapping_add(DOWNLINK_SEED_OFFSET)),
        )));
        app.add_systems(
            FixedUpdate,
            send_input.run_if(in_state(ClientState::Connected)),
        );
        app.add_systems(Update, conditioned_ingest);
    }
}

/// Capture each replicated mutation (timestamped with local arrival), pass it
/// through the downlink conditioner, and fold released items into the entity's
/// interpolation buffer — the render layer / measurement then reads buffer depth.
#[allow(clippy::type_complexity)]
fn conditioned_ingest(
    mut commands: Commands,
    time: Res<Time>,
    mut cond: ResMut<DownlinkConditioner>,
    mut tracked: Query<(Entity, Ref<NetPosition>, Ref<RoleFlags>, Option<&mut InterpTrack>)>,
) {
    let now = time.elapsed_secs_f64();
    for (entity, pos, flags, _) in &tracked {
        if pos.is_changed() || flags.is_changed() {
            cond.0.offer(now, (entity, pos.to_vec3(), flags.0, now));
        }
    }
    // Buffers for entities that have NO InterpTrack yet, staged locally: a
    // `commands.insert` is deferred, so if two items for the same not-yet-tracked
    // entity are released in one drain, inserting per-item would have the second
    // overwrite (and drop the sample of) the first. Accumulate into one buffer.
    let mut new_buffers: HashMap<Entity, InterpBuffer> = HashMap::new();
    for (entity, pos, flags, capture_time) in cond.0.drain_due(now) {
        match tracked.get_mut(entity) {
            Ok((_, _, _, Some(mut track))) => track.0.push(capture_time, pos, flags),
            Ok((_, _, _, None)) => new_buffers
                .entry(entity)
                .or_insert_with(|| InterpBuffer::new(MAX_SAMPLES))
                .push(capture_time, pos, flags),
            Err(_) => {} // entity despawned before its delayed sample released — drop it.
        }
    }
    for (entity, buffer) in new_buffers {
        commands.entity(entity).insert(InterpTrack(buffer));
    }
}

// --- App builders ---

fn build_probe_server_app(tick_rate: f64, seed: u32, uplink: LinkConfig) -> App {
    let mut app = App::new();
    app.add_plugins(MinimalPlugins);
    app.add_plugins(StatesPlugin);
    add_replication_plugins(&mut app);
    app.add_plugins(crate::protocol::NetProtocolPlugin);
    app.add_plugins(ProbeServerPlugin {
        tick_rate,
        seed,
        uplink,
    });
    app
}

fn build_probe_client_app(tick_rate: f64, downlink: LinkConfig, seed: u32) -> App {
    let mut app = App::new();
    app.add_plugins(MinimalPlugins);
    app.add_plugins(StatesPlugin);
    add_replication_plugins(&mut app);
    app.add_plugins(crate::protocol::NetProtocolPlugin);
    app.add_plugins(ProbeClientPlugin {
        tick_rate,
        downlink,
        seed,
    });
    app
}

// --- Runner ---

/// Per-stage progress callback: `(emitted sample, the stage, global stage index)`.
pub type StageCallback = Box<dyn FnMut(&MetricsSample, &Stage, usize)>;

/// Options for a scenario run.
pub struct RunOptions {
    /// RNG seed — reproduces bot motion exactly (loss draws use a derived stream).
    pub seed: u32,
    /// If set, every emitted sample is appended to this metrics.jsonl file.
    pub metrics_path: Option<PathBuf>,
    /// Optional per-stage progress callback (live logging).
    pub on_stage: Option<StageCallback>,
}

impl Default for RunOptions {
    fn default() -> Self {
        Self {
            seed: 1,
            metrics_path: None,
            on_stage: None,
        }
    }
}

/// One booted segment: the server app, its probe clients, and the bound address.
struct Segment {
    server: App,
    clients: Vec<App>,
}

/// A fresh, process-unique client id (nanos since epoch + an index) so concurrent
/// local clients never collide on netcode's id.
fn fresh_client_id(index: usize) -> u64 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(1);
    nanos.wrapping_add(index as u64 + 1)
}

/// Run a scenario end-to-end. Returns the per-stage samples in stage order; the
/// same metrics.jsonl is appended when `metrics_path` is set. Consecutive stages
/// sharing app-construction params (tick/shim/clientCount) reuse one boot and
/// live-ramp bots; a param change boots a fresh server + clients.
pub fn run_scenario(def: &ScenarioDef, mut opts: RunOptions) -> std::io::Result<Vec<MetricsSample>> {
    let mut writer = opts.metrics_path.take().map(MetricsWriter::new);
    let mut samples = Vec::new();
    let mut index = 0usize;

    for segment_stages in crate::scenario::plan_segments(&def.stages) {
        let first = segment_stages[0];
        let mut seg = boot_segment(first, opts.seed)?;

        for stage in &segment_stages {
            let sample = run_stage(&mut seg, stage, &def.id, opts.seed);
            if let Some(w) = writer.as_mut() {
                w.write(&sample)?;
            }
            if let Some(cb) = opts.on_stage.as_mut() {
                cb(&sample, stage, index);
            }
            samples.push(sample);
            index += 1;
        }
        // Drop the segment (apps + sockets) before the next boot.
        drop(seg);
    }
    Ok(samples)
}

/// Boot a server + `first.client_count` probe clients for one segment and pump
/// until every client is connected and its player has replicated.
fn boot_segment(first: Stage, seed: u32) -> std::io::Result<Segment> {
    let tick = clamp_tick(first.tick_rate);
    let mut server = build_probe_server_app(tick, seed, first.shim.up);
    let bind: SocketAddr = (Ipv4Addr::LOCALHOST, 0).into();
    let addr = start_server(&mut server, bind, MAX_CLIENTS)?;

    let mut clients = Vec::new();
    for i in 0..first.client_count {
        // Per-client seed (run seed + index) so each client's downlink loss draws
        // are independent — two clients must not drop the same-indexed snapshots.
        let mut c = build_probe_client_app(tick, first.shim.down, seed.wrapping_add(i as u32));
        start_client(&mut c, addr, fresh_client_id(i))?;
        // Constant +x intent so the probe's own entity moves (downlink traffic) and
        // its input frames exercise the uplink — mirrors the web probe (moveX = 1).
        c.world_mut().resource_mut::<ClientInput>().move_x = 1.0;
        clients.push(c);
    }

    // Manual-pump apps must finish()+cleanup() themselves (replicon sizes its
    // receive channels in ServerPlugin::finish()).
    server.finish();
    server.cleanup();
    for c in &mut clients {
        c.finish();
        c.cleanup();
    }

    let step = Duration::from_secs_f64(1.0 / tick);
    let start = Instant::now();
    while start.elapsed() < CONNECT_DEADLINE {
        if all_connected(&mut server, &mut clients, first.client_count) {
            break;
        }
        pump(&mut server, &mut clients, step);
    }
    // Fail rather than measure a half-connected segment: a stalled handshake would
    // otherwise emit misleading clientCount=0 / near-zero lines to metrics.jsonl
    // (the web runner likewise throws when connect retries are exhausted).
    if !all_connected(&mut server, &mut clients, first.client_count) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            format!(
                "probe segment did not fully connect within {CONNECT_DEADLINE:?}: \
                 {}/{} clients connected",
                connected_count(&mut server),
                first.client_count
            ),
        ));
    }
    Ok(Segment { server, clients })
}

/// Run one stage on a booted segment: apply the bot target, settle the warmup
/// window (discarded), then measure for `measure_ms` and reduce one sample.
fn run_stage(seg: &mut Segment, stage: &Stage, scenario: &str, seed: u32) -> MetricsSample {
    let tick = clamp_tick(stage.tick_rate);
    let step = Duration::from_secs_f64(1.0 / tick);

    seg.server.world_mut().resource_mut::<BotTarget>().0 = stage.bot_count;

    // Warmup: settle the ramp; the window is discarded afterwards.
    pump_for(&mut seg.server, &mut seg.clients, step, stage.warmup_ms);
    seg.server
        .world_mut()
        .resource_mut::<MetricsAccumulator>()
        .reset();

    // Measure: pump and, each pump, push client snapshot-age into the server's
    // accumulator (the per-tick server timings/bytes/stats are recorded by systems).
    let deadline = Instant::now() + Duration::from_millis(stage.measure_ms);
    while Instant::now() < deadline {
        pump(&mut seg.server, &mut seg.clients, step);
        for client in &mut seg.clients {
            if let Some(age) = client_snapshot_age(client) {
                seg.server
                    .world_mut()
                    .resource_mut::<MetricsAccumulator>()
                    .record_snapshot_age(age);
            }
        }
    }

    let client_count = connected_count(&mut seg.server) as u32;
    let ctx = SampleContext {
        scenario: scenario.to_string(),
        seed: seed as u64,
        tick_rate: tick,
        client_count,
        bot_count: stage.bot_count as u32,
        injected_delay_cto_s_ms: stage.shim.up.delay_ms,
        injected_delay_sto_c_ms: stage.shim.down.delay_ms,
        loss_pct: stage.shim.loss_pct(),
    };
    seg.server
        .world_mut()
        .resource_mut::<MetricsAccumulator>()
        .reduce(&ctx)
}

/// One synchronized step of the server + every client, plus a real sleep so the
/// localhost UDP stack delivers and `Time<Real>` (which drives renet + fixed ticks)
/// advances (the loopback-test pump pattern).
fn pump(server: &mut App, clients: &mut [App], step: Duration) {
    server.update();
    for c in clients.iter_mut() {
        c.update();
    }
    sleep(step);
}

/// Pump for at least `ms` milliseconds.
fn pump_for(server: &mut App, clients: &mut [App], step: Duration, ms: u64) {
    let deadline = Instant::now() + Duration::from_millis(ms);
    while Instant::now() < deadline {
        pump(server, clients, step);
    }
}

/// Whether every client reports `Connected` and the server registered them all.
fn all_connected(server: &mut App, clients: &mut [App], want: usize) -> bool {
    let server_ok = connected_count(server) >= want;
    let clients_ok = clients.iter().all(|c| {
        c.world()
            .get_resource::<State<ClientState>>()
            .is_some_and(|s| *s.get() == ClientState::Connected)
    });
    server_ok && clients_ok
}

/// Server-side connected client count.
fn connected_count(server: &mut App) -> usize {
    server
        .world_mut()
        .query_filtered::<Entity, With<ConnectedClient>>()
        .iter(server.world())
        .count()
}

/// Mean snapshot age (ms) across a client's interpolation tracks: `now - latest
/// sample time`. `None` if nothing has been buffered yet.
fn client_snapshot_age(client: &mut App) -> Option<f64> {
    let now = client.world().resource::<Time>().elapsed_secs_f64();
    let mut q = client.world_mut().query::<&InterpTrack>();
    let ages: Vec<f64> = q
        .iter(client.world())
        .filter_map(|t| t.0.latest_time().map(|lt| (now - lt) * 1000.0))
        .collect();
    if ages.is_empty() {
        None
    } else {
        Some(ages.iter().sum::<f64>() / ages.len() as f64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_tick_holds_the_10_to_30_band() {
        assert_eq!(clamp_tick(5.0), MIN_TICK_RATE, "below band clamps up to MIN");
        assert_eq!(clamp_tick(20.0), 20.0, "in-band unchanged");
        assert_eq!(clamp_tick(60.0), MAX_TICK_RATE, "above band clamps down to MAX");
        assert_eq!(clamp_tick(MIN_TICK_RATE), MIN_TICK_RATE);
        assert_eq!(clamp_tick(MAX_TICK_RATE), MAX_TICK_RATE);
    }
}
