# game-playgrounds

A monorepo of game-mechanics playgrounds in **three engines**, to verify what each can do, how each *feels*, and how each is to develop with AI agents. Each engine is a self-contained project in its own subdir.

## Subprojects

| Dir | Stack | Renderer | Build tool | AI-dev |
|-----|-------|----------|-----------|--------|
| `three/` | TypeScript + Three.js + Rapier | WebGL (→ WebGPU) | npm | ◎ |
| `babylon/` | TypeScript + Babylon.js + Havok | WebGL (→ WebGPU) | npm | ◎ |
| `bevy/` | Rust + Bevy 0.18 + bevy_rapier3d | wgpu (native) | cargo | ○ (Rust-optimized, see below) |

Each subdir has its **own `CLAUDE.md`** with engine-specific rules and commands. **Always read the subdir CLAUDE.md for the project you are working in.**

## Build & Run (per engine)

```bash
# Web
cd three   && npm install && npm run dev      # or: cd babylon && ...
cd three   && npm run build                   # must stay green

# Bevy
cd bevy && cargo check                         # fast verify — PREFER this in the dev loop
cd bevy && cargo run --features bevy/dynamic_linking   # run with fast incremental builds
```

## Core Values (shared)

1. **Faithful mechanic reproduction with honest feel notes** — every sample documents how it actually feels, including where it feels bad.
2. **Idiomatic per engine, minimal dependencies.**
3. **AI-Agent Developable** — code-first, no GUI editor, every sample self-contained and build-green.

## Chapters

1. **Single-machine mechanics** (`three/`, `babylon/`, `bevy/`) — done; written up in `COMPARISON.md`.
2. **Networking / multiplayer** (`net/`) — the current chapter. Goal: multiplayer
   **implementation patterns + performance characteristics** across the same engines,
   not reproducing a specific game. Server-authoritative + client-interpolation, with a
   fixed `metrics.jsonl` measurement schema locked before any sample is built. Web side
   piggybacks on **Colyseus**; native side uses **Bevy 0.18 + bevy_replicon**. See
   `net/CLAUDE.md` and `COMPARISON.md §8`.

## Won't Do

- GUI / visual editor; bespoke hand-made art (primitives / procedural / CC0 only); mobile build.
- (Networking was previously out of scope; as of the `net/` chapter it is **in scope** — see above.)
- Real-scale / viral-load networking infrastructure: multi-machine load, cloud-cost
  modeling, autoscaling. The `net/` chapter measures patterns + characteristics on a
  single machine (localhost); production-scale cost/scale behavior is an ops concern,
  not a mechanic-reproduction one — it fails the Core Value one-step test (see `COMPARISON.md` §8.6).

## Issues & dev-all

- **One issue tracker for the whole monorepo.** Each issue is labeled by engine: `engine:three`, `engine:babylon`, `engine:bevy`.
- One issue = one PR = build-green **in that subdir**.
- Run `/dev-all` filtered by engine label, or per issue. Each issue's body says which subdir it targets and the build command to use.

## Rust (Bevy) — AI-agent-optimized workflow

Rust compiles slowly and the borrow checker is strict. The `bevy/` subdir is deliberately configured so AI agents iterate fast:

1. **Verify with `cargo check`, not `cargo build`.** Type/borrow errors return quickly; do a full build only to actually run the window.
2. **`cargo clippy`** for lint guidance. Rust's compiler errors are precise — read and fix them. Strictness = fewer runtime surprises (a net win for autonomous agents).
3. **Fast incremental builds**: dev profile compiles dependencies at `opt-level = 3` (compiled once) and your code at `opt-level = 1`; `--features bevy/dynamic_linking` links Bevy as a dylib (the biggest iteration win).
4. **Headless logic tests**: sample logic is testable with `cargo test` using `MinimalPlugins` (no window) — agents verify behavior without a GPU window.
5. **Shared build cache for dev-all worktrees**: set `CARGO_TARGET_DIR` to a shared path (or use `sccache`) so each git worktree reuses compilation instead of rebuilding Bevy from scratch.
6. **Pin Bevy 0.18 APIs**: LLM training data often contains OLD Bevy APIs that won't compile. Use 0.18 only. Reference the working Bevy 0.18 project at `../../src/AnotherBall/avvy-world` for correct idioms.

Details: `bevy/CLAUDE.md`.

## Language

- Code comments & identifiers: English.
- Commits: concise single line, English.
