# bevy-playground

A growing collection of self-contained **Bevy (Rust)** samples that reproduce
game mechanics and let us judge how each one *feels* (操作性 / control
responsiveness). Sibling of `../three` and `../babylon` (TypeScript): the
**same sample lineup**, built in Bevy for an apples-to-apples engine
comparison. Built so Claude Code's `/dev-all` can autonomously add more
samples from GitHub Issues — one issue per sample (or sub-mechanic).

## Build & Run

```bash
cargo check                                # fastest verify (NO codegen/link) — use this in the loop
cargo test                                 # headless logic tests (MinimalPlugins, no window/GPU)
cargo run --features bevy/dynamic_linking  # fast incremental runs (dynamic-linked Bevy)
cargo clippy                               # lints
cargo run                                  # normal (static) run — slower link, distributable
```

> The **first** compile downloads + builds all of Bevy and is SLOW (several
> minutes). Subsequent `cargo check`s are fast.

## Project Structure

```
src/
  main.rs                       — App builder: DefaultPlugins + RapierPhysicsPlugin,
                                  menu UI (Bevy UI list), state-driven sample switching
  engine/                       — shared foundation plugins added ONCE in main.rs
    input.rs                    — FoundationInputPlugin: MoveIntent/LookState +
                                  pointer-lock; samples READ its resources
  samples/
    mod.rs                      — SampleMeta + AppState + registry (THE CONTRACT)
    s01_character_controller.rs — capsule WASD + follow camera + ground
    s02_physics_grab_throw.rs   — rapier raycast grab/throw (REPO-style)
    s03_paint_on_mesh.rs        — runtime-editable Image painted at hit UV
docs/
  SAMPLES.md                    — backlog catalog (each row = one GitHub issue)
.cargo/
  config_fast_builds.toml.example — OPTIONAL lld/mold linker config (copy to config.toml to enable)
```

## Core Values

Max 3. Every change must directly strengthen one (one-step test).

1. **Faithful mechanic + honest feel notes.** Each sample reproduces a real
   mechanic AND its module header records how it actually *feels*
   (responsiveness, jank). Goal = judgment, not a tech demo. Document bad feel.
2. **Idiomatic Bevy 0.18, minimal deps.** Only `bevy` + `bevy_rapier3d`.
   Samples read as clean ECS references — Plugin + Systems gated on state.
3. **AI-Agent Developable (code-first).** Everything is code — no GUI/scene
   editor. Each sample is one module, registered in one place
   (`samples/mod.rs`), and `cargo check`-green.

## Won't Do

- **GUI / visual scene editor** — code-first only (breaks Core Value 3).
- **Bespoke hand-made 3D art** — primitives / procedural / CC0 only. This tests
  *mechanics*, not art.
- **Networking / multiplayer** — single-machine mechanic verification only.
- **Mobile build** — target is desktop (→ Steam via a desktop shell). This
  genre is PC/Steam-first.

## Tech Stack

| Layer | Technology |
|---|---|
| Language | Rust (stable, edition 2021) |
| Engine / ECS | Bevy `0.18` |
| Physics | `bevy_rapier3d` `0.34` (dim3) |
| Verify | `cargo check` / `cargo test` (headless) / `cargo clippy` |
| Runtime target | Desktop (winit window) |

Versions are pinned to match the reference project `avvy-world` (a real,
working Bevy 0.18 game) — see AI-agent rules below.

## Adding a Sample (the contract `/dev-all` follows)

1. Create `src/samples/sNN_name.rs` with a module-doc header:
   **What it demonstrates / Controls / Feel notes / Bevy 0.18 gotchas.**
2. Expose a `Plugin` (e.g. `pub struct FooPlugin;`) and
   `pub const META: SampleMeta = SampleMeta { id, title, summary, tags };`.
3. In the plugin, run gameplay systems gated on the sample's own `AppState`
   arm: `OnEnter(AppState::SNN..)` for setup, and
   `.run_if(in_state(AppState::SNN..))` for per-frame systems.
4. Tag every spawned entity with `DespawnOnExit(AppState::SNN..)` so leaving
   the sample auto-cleans up (NO manual teardown, NO leaks between samples).
5. Register in `src/samples/mod.rs`: add an `AppState` variant, a row in
   `all()`, and the plugin in `register_samples()`.
6. Add at least one headless `#[test]` (MinimalPlugins) asserting the mechanic.
7. `cargo check` must pass. **One issue = one PR = `cargo check` green.**

## AI-agent fast-iteration rules

- **Verify with `cargo check`, not a full build.** It skips codegen + linking
  (the slow part) and catches all type/borrow errors. Use it in the loop.
- **`cargo test` is headless** — it builds an `App` with `MinimalPlugins` (no
  window, no renderer) so you can assert behavior without a GPU. Prefer this
  over opening the window to verify logic.
- **For an actual run, use `cargo run --features bevy/dynamic_linking`** —
  dynamic linking makes incremental rebuilds dramatically faster. Do NOT make
  `dynamic_linking` the default (it is dev-only and not distributable).
- **Shared `CARGO_TARGET_DIR` across `/dev-all` worktrees.** When running many
  agents in parallel worktrees, set a single shared target dir
  (`export CARGO_TARGET_DIR=/abs/shared/target`) so Bevy is compiled ONCE and
  every worktree reuses the artifacts. Without it each worktree rebuilds all of
  Bevy from scratch.
- **Optional linker speedup:** copy `.cargo/config_fast_builds.toml.example` to
  `.cargo/config.toml` and install `lld`/`mold` (see that file). Kept inert by
  default so machines without lld are not broken.
- **PIN Bevy 0.18. Reference `avvy-world`, do NOT use older Bevy APIs.** LLM
  training data is full of pre-0.15 patterns that will NOT compile (see gotchas).

## Bevy 0.18 gotchas (verified against avvy-world)

- **No bundles.** Spawn components directly as a tuple. Meshes use
  `Mesh3d(mesh_handle)` + `MeshMaterial3d(material_handle)` — the old
  `PbrBundle` / `MaterialMeshBundle` / `spawn_bundle` are GONE.
- **Scoped despawn is `DespawnOnExit(state)`** (a component you attach), NOT the
  older `StateScoped`. Add `.init_state::<S>()`; the despawn system is built in.
- **Rapier 0.34 raycast goes through `ReadRapierContext`** (a SystemParam), not
  `Res<RapierContext>`. Call `rapier.single()?.cast_ray(origin, dir, max_toi,
  solid, QueryFilter::default())` → `Option<(Entity, f32)>`. The
  `ReadRapierContext` wrapper's `cast_ray` takes a 5th `QueryFilter` arg (the
  lower-level `RapierContext::cast_ray` omits it — don't confuse the two).
- **`Image.data` is `Option<Vec<u8>>`** in 0.18 (was `Vec<u8>`). Build textures
  with `Image::new_fill(Extent3d, TextureDimension::D2, &pixel, TextureFormat,
  RenderAssetUsages::all())`; `Extent3d`/`TextureDimension`/`TextureFormat` are
  in `bevy::render::render_resource`, `RenderAssetUsages` in `bevy::asset`.
- **Time delta is `time.delta_secs()`** (f32), not `delta_seconds()`.
- **`Query::single()` / `single_mut()` return `Result`** — handle with
  `let Ok(..) = q.single() else { return; };`.
- **UI uses `Node` + `Text::new(..)` + `TextFont`/`TextColor`** — no
  `NodeBundle`/`TextBundle`/`Style`. `Button` is a marker component.

## Language

- Code comments & identifiers: English.
- Commits: concise single line, English.
