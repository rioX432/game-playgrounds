# bevy-playground

A growing collection of self-contained **Bevy (Rust)** samples that reproduce
game mechanics and let us judge how each one *feels* (control
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
    nav.rs                      — Ch4 navigation foundation: pure-CPU navmesh
                                  build + Polyanya path query (vleue_navigator),
                                  Recast bake wiring (bevy_rerecast), gizmo debug
                                  helpers; headless tests. See nav-crate exception
  samples/
    mod.rs                      — SampleMeta + AppState + registry (THE CONTRACT)
    s01_character_controller.rs — capsule WASD + follow camera + ground
    s02_physics_grab_throw.rs   — rapier raycast grab/throw (REPO-style)
    s03_paint_on_mesh.rs        — runtime-editable Image painted at hit UV
docs/
  SAMPLES.md                    — catalog of built samples (all 12, with links)
.cargo/
  config_fast_builds.toml.example — OPTIONAL lld/mold linker config (copy to config.toml to enable)
```

## Core Values

Max 3. Every change must directly strengthen one (one-step test).

1. **Faithful mechanic + honest feel notes.** Each sample reproduces a real
   mechanic AND its module header records how it actually *feels*
   (responsiveness, jank). Goal = judgment, not a tech demo. Document bad feel.
2. **Idiomatic Bevy 0.18, minimal deps.** Only `bevy` + `bevy_rapier3d`
   (plus the **scoped Ch4 nav-crate exception** below — `bevy_rerecast` +
   `vleue_navigator`, NPC-AI chapter only). Samples read as clean ECS
   references — Plugin + Systems gated on state.
3. **AI-Agent Developable (code-first).** Everything is code — no GUI/scene
   editor. Each sample is one module, registered in one place
   (`samples/mod.rs`), and `cargo check`-green.

## Ch4 nav-crate exception (NPC/AI chapter ONLY)

Core Value #2 mandates **`bevy` + `bevy_rapier3d` only**. The Chapter 4 NPC/AI
samples (navmesh-pathfind, guard-ai) are the **one explicit, scoped exception**:
they add two navigation crates. This was flagged in design review (Codex) and is
recorded here so it does **not** silently cascade to other chapters.

| Crate | Pin | Role | Why it can't be hand-rolled |
|---|---|---|---|
| `bevy_rerecast` | `0.4` | Recast **navmesh baking** from `Mesh3d` scene geometry (generation only, async/asset) | Recast voxelization + region/contour/poly building is a large, well-trodden algorithm; reimplementing it is out of scope and would not be idiomatic. |
| `vleue_navigator` | `0.15` | Polyanya **path query** (pure-CPU, headless-deterministic) | The whole point of the chapter is to compare a *different* nav core (Polyanya) against the web engines' Recast/Detour — using the real crate IS the experiment. |

**Scope guard (do NOT cross these lines):**

- **Ch4 nav only.** No other chapter may add these (or further nav/AI crates)
  without its own documented exception. Chapters 1–3 stay `bevy` + `bevy_rapier3d`.
- **Steering & FSM stay hand-rolled.** No `bevy-steering` / behaviour-tree /
  GOAP crates — those are reproduced by hand so the cross-engine comparison
  isn't confounded by third-party AI libraries (design §3, §4).
- **Feature-trimmed for minimal deps:** `bevy_rerecast` uses
  `default-features = false, features = ["bevy_mesh"]` (drops the GUI
  editor-integration crate — Core Value #3, code-first); `vleue_navigator` uses
  `default-features = false` (drops `bevy_gizmos`; debug drawing uses bevy's own
  `Gizmos`). The Triangulation/NavMesh/path query core is feature-independent.

**Two crates, two roles — no first-party bridge.** `bevy_rerecast` bakes a
Recast `Navmesh` asset; `vleue_navigator` queries a Polyanya `NavMesh`; neither
converts to the other in 0.4 / 0.15. So the **headless `cargo test` proof**
(`src/engine/nav.rs`) goes through vleue's own CDT navmesh-gen + query (pure CPU,
deterministic) and asserts only **robust properties** — goal reached, no
intrusion into the blocked AABB, detour longer than the straight line — NOT an
exact path point-sequence (which drifts: Polyanya vs Detour, float, WASM init).
rerecast's async Recast pipeline is proven by compile + a headless plugin-build
test (it is the baking path for the later *visual* samples).

**Bevy 0.18.1 pin / 0.19 deferral.** rerecast 0.4 and vleue 0.15 are the newest
releases and both require `bevy ^0.18`; **no 0.19-compatible nav crate exists**
(crates.io max = rerecast 0.4.0, vleue 0.15.0, checked 2026-06-29). We therefore
stay on **Bevy 0.18.1** for the whole chapter and **defer 0.19**. Revisit a 0.19
migration only once both nav crates publish 0.19-compatible releases
(e.g. vleue 0.16 / rerecast 0.5).

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
| Navigation (Ch4 only) | `bevy_rerecast` `0.4` (Recast bake) + `vleue_navigator` `0.15` (Polyanya query) — see "Ch4 nav-crate exception" |
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
