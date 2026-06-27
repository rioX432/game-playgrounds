# net/bevy — Bevy 0.18 native replication (dependency SPIKE)

The native authority + client side of the net/ chapter, in **Bevy 0.18 + bevy_replicon**.
This subdir started as the **dependency spike** (issue #145): step on the
version-compatibility landmine FIRST, before any server/client logic (#146).

> Separate Cargo project from `../../bevy`. **Bevy 0.18 ONLY** — LLM training data
> is full of older Bevy APIs that will not compile. Use 0.18 idioms only;
> reference `../../../src/AnotherBall/avvy-world` if needed.

## Build & verify

```bash
cargo check                                  # the deliverable — must stay GREEN
cargo check --features bevy/dynamic_linking  # faster incremental (dylib-linked Bevy)
cargo test                                   # headless: app builds + one tick, no window
cargo clippy                                 # lints
```

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

## Plugin set (the skeleton)

`src/lib.rs::build_app()` registers, on a headless `App`:
`MinimalPlugins` + `StatesPlugin` + `RepliconPlugins` + `RepliconRenetPlugins`.

- `StatesPlugin` is added explicitly because replicon depends on Bevy states and
  `MinimalPlugins` (unlike `DefaultPlugins`) does not include it.
- `RepliconRenetPlugins` default features (`client` + `server` + `renet_netcode`)
  register both backend roles. replicon itself does **no I/O** — renet is the
  messaging backend.
- Verified against docs.rs for `bevy_replicon` 0.40 and `bevy_replicon_renet` 0.16.

There is **no** gameplay, transport binding, or replicated component here — that is
deliberate. Server authority + client interpolation arrive in **#146**.

## Language
- Code comments & identifiers: English.
- Commits: concise single line, English.
