# net/bevy — Bevy 0.18 native replication (N1 + N2 probe)

The native authority + client side of the net/ chapter, in **Bevy 0.18 + bevy_replicon**.
This subdir started as the **dependency spike** (#145: step on the version-compat
landmine first), carries the **N1 sample** (#146): a server-authoritative
replication + client-interpolation playground that mirrors the web N1
(`net/web-three` + `net/server`) in Rust/ECS, and now the **N2 load probe** (#147):
the Rust counterpart of the web N2 probe (#144) that emits the SAME #140
`metrics.jsonl` schema so #148 can diff Web vs Bevy apples-to-apples.

> Separate Cargo project from `../../bevy`. **Bevy 0.18 ONLY** — LLM training data
> is full of older Bevy APIs that will not compile. Use 0.18 idioms only;
> reference `../../../src/AnotherBall/avvy-world` if needed.

## Build & verify

```bash
cargo check                                  # fast verify — must stay GREEN
cargo check --features bevy/dynamic_linking  # faster incremental (dylib-linked Bevy)
cargo test                                   # headless unit tests (sim + interpolation)
cargo test --test net_loopback               # real 127.0.0.1-UDP server↔client loopback
cargo clippy --all-targets                   # lints (kept clean)
cargo run -- --server                        # headless authority on 127.0.0.1:5010
cargo run -- --client [host:port]            # windowed client (DefaultPlugins)
cargo run -- --scenario                      # headless N2 load probe -> metrics.jsonl
cargo test --test probe_scenario             # real-UDP N2 probe (tiny shrunk run)
```

## N2 load probe (#147)

The Rust counterpart of the web N2 probe (#144). It boots a headless
authoritative server + N real-UDP probe clients **in one process**, ramps
server-internal **bots** to scale the synchronized-entity count, injects
**app-level** bidirectional impairment, and emits one `MetricsSample` line per
scenario stage to `metrics.jsonl` — the SAME #140 schema the web probe writes.

| `SCENARIO` | sweeps | boots |
|------------|--------|-------|
| `n2-stress-ramp` (default) | sync count `BOTS=2,8,16,24,50,100` @ fixed tick / clean | one app, live bot ramp |
| `n2-tickrate-sweep` | `TICKS=10,15,20,30` @ fixed `BOT_COUNT` | fresh app per tick |
| `n2-latency-sweep` | bidirectional delay+loss points @ fixed `BOT_COUNT` | fresh app per point |
| `adhoc` | single-shim bot ramp from `DELAY_*` / `LOSS_*` | one app, live bot ramp |

Env knobs (all optional, mirror the web `npm run scenario`): `SCENARIO SEED OUT
WARMUP_MS MEASURE_MS CLIENTS TICK BOTS BOT_COUNT TICKS DELAY_UP_MS DELAY_DOWN_MS
LOSS_UP_PCT LOSS_DOWN_PCT`. `BOTS`/`TICKS` accept comma ramps. Example:
`SCENARIO=n2-stress-ramp BOTS=2,24,100 CLIENTS=2 WARMUP_MS=300 MEASURE_MS=800 OUT=metrics.jsonl cargo run -- --scenario`

### Module map (additive to N1 — N1 is untouched)

| Module | Role |
|--------|------|
| `metrics` | `MetricsSample` (serde→IDENTICAL #140 camelCase JSON) + windowed `MetricsAccumulator` + JSONL writer. A test pins the 18-field set. |
| `rng` | mulberry32 ported from the web `rng.ts` — same seed ⇒ same bot-motion draws. |
| `conditioner` | app-level delay/loss link (the `TransportShim` mirror). |
| `bots` | server-internal **replicated** bot entities, seeded random walk (`BotDriver` mirror). |
| `scenario` | `Stage`/`ScenarioDef` + named builders + `plan_segments` (the `defs.ts`/runner mirror). |
| `probe` | `ProbeServerPlugin` (timing + bytes + stats + conditioned uplink), `ProbeClientPlugin` (conditioned downlink), and `run_scenario`. |

### Honest-parity — what is measured, and where Bevy/replicon CANNOT mirror the web

Core Value #1 is non-negotiable: every metric is **measured**, never faked; a
field that cannot be faithfully measured is **documented**, not stuffed with a
misleading number. Verified against crate source (`bevy_replicon 0.40.4`,
`renet 2.0.0` — extracted & read, not guessed).

| metric | Bevy source | parity verdict |
|--------|-------------|----------------|
| `serverTickSimMs` | timed `FixedUpdate` sim set (bot drive + integrate) | **TRUE parity** |
| `serverTickSerializeMs` | timed replicon `ServerSystems::Send` set (build + postcard into `ServerMessages`) | **honest split** — not the web's `buildSnapshot` boundary, but a real replicon-set boundary |
| `serverTickSendMs` | timed `ServerSystems::SendPackets` + renet `RenetSend` socket flush | **honest split** (same caveat) |
| `bytesUp/DownPerSec` | app payload sized with **postcard** (replicon's native encoder), full snapshot/tick/client | **parity of definition**; encoding differs (postcard binary vs web JSON) ⇒ absolute bytes are not comparable, the **down/serialize scaling** is. CAVEAT: uplink rate differs (GAP 3) |
| `transportBytesPerSec` | renet `ConnectedClientStats.{sent,received}_bps` (`RenetServer::network_info`) | **better than web** — real wire bytes, not "payload + constant" estimate. renet-packet bytes (incl. renet framing; excl. netcode tag + UDP/IP headers), over renet's 6 s window |
| `rttP50/P95Ms` | renet transport RTT (`ConnectedClientStats.rtt`) | **DOCUMENTED GAP** (two parts, below) |
| `snapshotAgeMs` | probe-client interp-buffer depth (`now − latest sample time`) | **TRUE parity** |
| `injectedDelay*`, `lossPct` | scenario knobs; `lossPct = max(up,down)` | **TRUE parity** |

**GAP 1 — latency/loss injection is app-level, not transport-level.** renet 2.0
ships **no network conditioner** (it only *reports* loss/rtt), and `renet_netcode`
2.0 takes a concrete `std::net::UdpSocket` (not a trait), so a conditioning socket
can't be slotted under the transport and a UDP relay would fight netcode address
validation. So — exactly like the web shim (also app-level over Colyseus's reliable
channel) — impairment is injected in app code: **uplink** conditions the server
folding a received `InputMessage`; **downlink** conditions the probe client folding
a replicated mutation into its interp buffer (receive-side, because replicon owns
send). Observable effect (staler `snapshotAge`, dropped frames) matches the web
shim; what differs is GAP 2.

**GAP 2 — RTT does not reflect app-injected delay.** Because injection sits ABOVE
netcode, renet's transport RTT measures only the real localhost link, so under a
latency sweep `rttP50/P95Ms` stay near the floor; the injected delay surfaces in
`snapshotAge` (down) instead. The web app-echo RTT, by contrast, passes through its
shim. This is a real cross-engine difference (a §8 finding), not a bug.

**GAP 3 — uplink input rate is the tick rate, not a fixed 30 Hz.** The web probe
sends input at a wall-clock `PROBE_INPUT_HZ = 30` regardless of tick; the Bevy probe
sends in `FixedUpdate`, i.e. at the server tick rate (10–30 Hz). So under
`n2-tickrate-sweep`, `bytesUpPerSec` scales with tick on Bevy but is flat on Web —
do NOT cross-compare the uplink-bytes axis under a tick sweep. The downlink, server-
tick-cost, and transport axes (the probe's primary signals) are unaffected.

**Harness caveat — in-process manual pump.** The runner pumps `update()` at the
tick cadence with a real sleep per step (the loopback-test pattern), so renet
**RTT and `snapshotAge` absolute floors are quantized to ≈ one tick period** (e.g.
~50 ms at 20 Hz) — RTT at loopback is therefore a coarse proxy, not sub-ms. The
**bytes** and **server-tick-cost** axes are precise; treat RTT cross-engine
absolutes as directional. (`serverTickSendMs` remains only meaningful at zero
down-delay, carried over from #144 — though here down-delay is a client-side fold
deferral, so it doesn't perturb the server send path the way the web shim did.)

### Headless testability

`tests/probe_scenario.rs` runs a SHRUNK scenario over real localhost UDP (tiny
windows) and asserts every emitted line is a schema-valid #140 sample with
`engine="bevy"`, in-memory AND on disk. Like `net_loopback.rs` it loads only the
headless plugin set (never `NetRenderPlugin`) and drives `update()` via a bounded
pump loop (`finish()`+`cleanup()` first, so replicon sizes its receive channels).

## N1 architecture (render / net-sim separation)

The crate is split so the simulation + networking is **headless-testable** and the
render layer is the only part that needs a GPU/window (an acceptance criterion):

| Module | Role | Window? |
|--------|------|---------|
| `protocol` | replicated sim components `NetPosition` / `RoleFlags` + client→server `InputMessage`; `NetProtocolPlugin` registers them | no |
| `sim` | pure authoritative integration (clamp to arena, flags) — free functions, no `App` | no |
| `interpolation` | pure per-entity snapshot `InterpBuffer` (lerp + clamp, no extrapolation) | no |
| `server` | `NetServerSimPlugin`: spawn player on connect, fold input, integrate on the fixed tick | no |
| `client` | `NetClientSimPlugin`: send input, fold replicated state into interpolation buffers | no |
| `transport` | renet (UDP) endpoint construction for both roles | no |
| `render` | `NetRenderPlugin`: `DefaultPlugins`, camera, capsules, keyboard. Added ONLY by `--client` | **yes** |

**Codex rule baked in:** never replicate the render `Transform` and then smooth
it. The server replicates small sim components; the client buffers each mutation
(timestamped) and the render layer writes `Transform` FROM the interpolation
buffer at `now - interp_delay`. Replicon sends only CHANGED values (the server
writes components via `set_if_neq`, so an idle player produces no traffic).

The `tests/net_loopback.rs` test runs TWO separate apps (server + client) in one
process over real localhost UDP and asserts join → input → snapshot (position +
role-flags) → leave. It loads only the headless plugin set (never `NetRenderPlugin`)
and, because it drives `update()` manually rather than `run()`, calls
`app.finish()` + `app.cleanup()` first — replicon sizes its receive channels in
`ServerPlugin::finish()`.

> First compile builds all of Bevy + replicon + renet and is SLOW. To avoid a cold
> rebuild across `/dev-all` worktrees, share the build cache per the root CLAUDE.md
> "Rust (Bevy)" guidance, e.g. `export CARGO_TARGET_DIR=/abs/shared/target` (or
> sccache). Subsequent `cargo check`s are fast.

## Version pins (EXACT `=`, verified against crates.io — NOT assumed)

The issue *targeted* "replicon 0.40 + renet 0.16". `#140`'s note flagged that, at
that time, crates.io's latest replicon was ~0.38 and a 0.40 with a Bevy-0.18 range
might not be published. That caveat is now **resolved** — the targets are real and
Bevy-0.18-compatible. Evidence from the crates.io sparse index (the published
`bevy` dependency range each version declares):

| Crate | Pin | Declared `bevy` range | Next version bumps to |
|-------|-----|-----------------------|-----------------------|
| `bevy` | `=0.18.1` | — (latest 0.18 patch; same resolved version as `../../bevy`, which uses caret `0.18`) | 0.19 |
| `bevy_replicon` | `=0.40.4` | `^0.18` | `0.41.0 → ^0.19` |
| `bevy_replicon_renet` | `=0.16.0` | `^0.18.0` (also `bevy_replicon = ^0.40.0`, `bevy_renet = ^4.0`) | `0.17.0 → bevy ^0.19` |

Sources (crates.io sparse index — authoritative per-version dependency metadata):
- `https://index.crates.io/be/vy/bevy_replicon` → 0.40.0–0.40.4 declare `bevy ^0.18`; 0.41.0 declares `bevy ^0.19`.
- `https://index.crates.io/be/vy/bevy_replicon_renet` → 0.16.0 declares `bevy ^0.18.0`, `bevy_replicon ^0.40.0`, `bevy_renet ^4.0`; 0.17.0 declares `bevy ^0.19`.
- `https://index.crates.io/be/vy/bevy` → latest 0.18 patch is 0.18.1.

**Why EXACT `=` and not caret:** `bevy_replicon` 0.41 and `bevy_replicon_renet`
0.17 both jump to Bevy 0.19. A caret (`^0.40`, `^0.16`) or `latest` would resolve
to those and silently pull a 0.19-era Bevy — the exact landmine this spike exists
to defuse. Pin re-verification is required whenever bumping Bevy.

## Plugin set

`src/lib.rs::add_headless_net_plugins()` registers, on a headless `App`:
`MinimalPlugins` + `StatesPlugin` + `RepliconPlugins.set(ServerPlugin::new(PostUpdate))`
+ `RepliconRenetPlugins`. `build_server_app()` / `build_client_app()` add the
protocol + the role's sim plugin on top; the `--client` binary swaps
`MinimalPlugins` for `DefaultPlugins` and adds `NetRenderPlugin`.

- `StatesPlugin` is added explicitly because replicon depends on Bevy states and
  `MinimalPlugins` (unlike `DefaultPlugins`) does not include it.
- `ServerPlugin::new(PostUpdate)` makes replication send on every `update()` (the
  default `tick_schedule` is `FixedPostUpdate`), which keeps the loopback test
  order-insensitive.
- `RepliconRenetPlugins` adds the renet backend *plugins*; the renet endpoints
  (`RenetServer`/`RenetClient` + netcode transports) are inserted separately in
  `transport.rs`. replicon itself does **no I/O**.

## Verified replicon-0.40 / renet-2.0 API names (training data is stale)

Checked against docs.rs + the version-matched `bevy_replicon_renet` 0.16 example.
Names that differ from older/common forms:

- Client→server uses **messages** (not "events"/"triggers"):
  `app.add_client_message::<M>(Channel::Ordered)`; the client sends with
  `MessageWriter<M>`, the server reads `MessageReader<FromClient<M>>`.
  `FromClient { client_id, message }` — `client_id` is `ClientId` (an `enum
  { Client(Entity), Server }`; `.entity()` is the `ConnectedClient` entity).
- `Channel` = `{ Unreliable, Unordered, Ordered }` (passed by value).
- `AppRuleExt::replicate::<C>()` bound is `Component<Mutability: MutWrite> +
  Serialize + DeserializeOwned`.
- `ClientState`/`ServerState` are Bevy **`States`** (use `in_state(...)`), not
  resources; replicon `init_state`s them.
- Authorization is automatic under the default `AuthMethod::ProtocolCheck` (same
  binary ⇒ same hash ⇒ replicon auto-inserts `AuthorizedClient`) — no manual step.
- renet endpoints come from `bevy_replicon_renet::{RenetServer, RenetClient}`
  (the bevy_renet Resource *wrappers*), NOT `::renet::RenetServer` (the bare
  renet type does **not** impl `Resource`). renet resolves to **2.0.0** /
  renet_netcode **2.0.0** via `bevy_renet 4.0`. `ConnectionConfig` is a struct
  literal (`server_channels_config`/`client_channels_config` from
  `RenetChannelsExt::{server_configs, client_configs}`). `ServerAuthentication::
  Unsecure`; `ServerConfig.public_addresses: Vec<SocketAddr>`.

## Language
- Code comments & identifiers: English.
- Commits: concise single line, English.
