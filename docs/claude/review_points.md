# review_points.md

Reusable prevention insights extracted from self-reviews. Reference this during
design + implementation to avoid repeating mistakes. Keep entries as **rules**,
not as a log of past PRs.

## Bevy 0.18 + bevy_replicon / bevy_renet

- **Manually-driven apps (`update()` in a loop, not `run()`) must call
  `app.finish()` + `app.cleanup()` before pumping.** Plugins that do setup in
  `Plugin::finish()` are otherwise skipped. Concretely: replicon sizes its
  per-channel receive buffers in `ServerPlugin::finish()`; skip it and the first
  client-message receive panics with "server should have a receive channel".

- **renet endpoints are inserted as the bevy_renet Resource *wrappers*
  (`bevy_replicon_renet::{RenetServer, RenetClient}`), NOT the bare
  `::renet::RenetServer`** — the bare renet 2.0 type does not impl `Resource`.
  When a re-exported type "is not a Resource", check whether the integration crate
  defines a wrapper newtype at its crate root (`pub use bevy_renet::*`).

- **`MinimalPlugins`' `ScheduleRunnerPlugin` defaults to `Loop { wait: None }`** —
  a headless `run()` then spins a core at 100%. Cap it:
  `MinimalPlugins.set(ScheduleRunnerPlugin::run_loop(tick_duration))`.

- **Replicate small sim components and write `Transform` FROM an interpolation
  buffer — never replicate `Transform` and smooth it in place.** Buffer each
  replicated mutation (timestamped) on the client; the render layer reads it.

- **When several components replicate independently (written via `set_if_neq`), a
  client-side change-detection ingest must react to ALL of them, not just one.**
  Gating the buffer push on only `NetPosition.is_changed()` silently drops
  flag-only updates (a stationary player toggling a boolean state). Use
  `Ref<A>` + `Ref<B>` and push on `a.is_changed() || b.is_changed()`.

## Verifying third-party APIs (No-Guessing rule)

- **LLM training data carries stale crate APIs.** For replicon/renet specifically,
  verify names against docs.rs for the *exact* pinned version AND the installed
  source under `~/.cargo/registry/src/...` before use. Names that bit us:
  client→server is **messages** (`add_client_message` / `MessageReader<FromClient<_>>`),
  not "events"; `ClientState`/`ServerState` are Bevy `States`; auth is automatic
  under default `ProtocolCheck`.

## Tests

- **An interpolation/buffer assertion that samples at `latest_time()` only tests
  the clamp-to-newest branch, not the lerp.** To cover the real render path,
  sample at the same delayed time render uses (`now - interp_delay`).
- **A regression test must isolate the path that broke.** If the integration test
  couples two inputs (e.g. move + fire together), add a focused test for each
  branch so the decoupled case can't silently regress.
