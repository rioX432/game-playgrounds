# bevy-playground

A **Bevy (Rust)** game-mechanics playground — a growing collection of
self-contained samples that verify what Bevy can do and, just as importantly,
how each mechanic actually *feels* (操作性). Sibling of the TypeScript
`../three` and `../babylon` playgrounds (same sample lineup, different engine).
New samples are added autonomously from GitHub Issues via Claude Code's
`/dev-all`.

## Quick start

```bash
cargo check                                # fastest verify (no link) — use in the loop
cargo test                                 # headless logic tests (no window/GPU)
cargo run --features bevy/dynamic_linking  # fast incremental run (opens a window)
cargo clippy                               # lints
```

> The **first** compile downloads + builds all of Bevy and is SLOW (several
> minutes). That is expected; later `cargo check`s are fast.

## How it works

- `src/main.rs` builds the `App` (DefaultPlugins + Rapier), shows a **menu**
  listing every sample, and switches Bevy **States** when you pick one.
- Each sample is one module `src/samples/sNN_name.rs` exposing a `Plugin` + a
  `META: SampleMeta`, registered in `src/samples/mod.rs`. Its entities are
  tagged `DespawnOnExit(state)` so leaving a sample cleans up automatically.
- Rendering/ECS: **Bevy 0.18**. Physics: **bevy_rapier3d 0.34**. Versions are
  pinned to match the reference project `avvy-world`.

## Docs

- `docs/SAMPLES.md` — the backlog (each row = one GitHub issue = one PR)
- `CLAUDE.md` — project rules, Core Values, Won't Do, **Bevy 0.18 gotchas**,
  AI-agent fast-iteration rules, and the "Adding a Sample" contract.

## Stack

Rust (edition 2021) · Bevy 0.18 · bevy_rapier3d 0.34 (dim3)
