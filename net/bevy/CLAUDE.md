# net/bevy — Bevy 0.18 native replication (N1)

The native authority + client side of the net/ chapter, in **Bevy 0.18 + bevy_replicon**.
This subdir started as the **dependency spike** (#145: step on the version-compat
landmine first) and now carries the **N1 sample** (#146): a server-authoritative
replication + client-interpolation playground that mirrors the web N1
(`net/web-three` + `net/server`) in Rust/ECS.

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
```

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
