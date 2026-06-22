# Adding a Sample

This is the detailed how-to for implementing, registering, and documenting a new
playground sample. It is the procedure `/dev-all` follows for each GitHub issue in
`docs/SAMPLES.md`. The sibling guides are `../../three/docs/ADDING-A-SAMPLE.md`
and `../../babylon/docs/ADDING-A-SAMPLE.md`; this is the Bevy version.

> **Single source of truth for Bevy 0.18 APIs:** [`../CLAUDE.md`](../CLAUDE.md)
> ("Bevy 0.18 gotchas"). When in doubt, copy idioms from the reference project
> `avvy-world`, not from memory — LLM training data is full of pre-0.15 APIs that
> won't compile.

## 1. The contract

Each sample is one module exposing a `Plugin` and a `META`, registered in
`src/samples/mod.rs`:

```rust
pub const META: SampleMeta = SampleMeta {
    id: "sNN-kebab-name",   // also the menu entry
    title: "Human Title",
    summary: "One line: the mechanic and how you interact with it.",
    tags: &["physics", "raycast"],
};

pub struct FooPlugin;
impl Plugin for FooPlugin { /* systems gated on AppState::SNN.. */ }
```

Gameplay systems are gated on the sample's own `AppState` arm: `OnEnter` for
setup, `.run_if(in_state(AppState::SNN..))` for per-frame systems. Every spawned
entity is tagged `DespawnOnExit(AppState::SNN..)` so leaving the sample
auto-cleans up — **no manual teardown**.

## 2. Create the module

```
src/samples/sNN_name.rs
```

Start with the module-doc header (it IS the sample's README — there is no separate
file, unlike the TS playgrounds):

```rust
//! sNN — Human Title
//!
//! What it demonstrates: the mechanic and the Bevy/Rapier features used.
//! Controls: key → action.
//! Feel notes: honest — snappy/floaty/janky, the tuning constants that matter,
//!   and where it feels bad.
//! Bevy 0.18 gotchas: the non-obvious traps you hit.
```

## 3. Implement

Skeleton:

```rust
use bevy::prelude::*;
use crate::samples::{AppState, SampleMeta};

pub struct FooPlugin;

impl Plugin for FooPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(OnEnter(AppState::SNNFoo), setup)
           .add_systems(Update, tick.run_if(in_state(AppState::SNNFoo)));
    }
}

fn setup(mut commands: Commands, mut meshes: ResMut<Assets<Mesh>>,
         mut mats: ResMut<Assets<StandardMaterial>>) {
    commands.spawn((
        Mesh3d(meshes.add(Capsule3d::default())),
        MeshMaterial3d(mats.add(Color::WHITE)),
        Transform::default(),
        DespawnOnExit(AppState::SNNFoo),   // REQUIRED on every spawned entity
    ));
}

fn tick(/* queries, Res<Time>, shared input resources */) { /* ... */ }
```

### Rules that matter

- **Read shared input, don't re-add it.** `engine/input.rs` (`FoundationInputPlugin`)
  is added once in `main.rs`; consume its `MoveIntent` / `LookState` resources.
- **Spawn components directly** — no bundles. `Mesh3d(handle)` +
  `MeshMaterial3d(handle)`, never `PbrBundle`.
- **`DespawnOnExit(state)` on every entity** — not the old `StateScoped`.
- **Resources are NOT cleared by `DespawnOnExit`.** Any per-sample `Resource`
  (timers, phase state) must be reset in the `OnEnter` system, or it bleeds into
  the next visit. See s08 / s12.
- **Rapier 0.34:** raycast via `ReadRapierContext` (a SystemParam), not
  `Res<RapierContext>`; `time.delta_secs()` not `delta_seconds()`;
  `Query::single()` returns `Result`. Full list in `../CLAUDE.md`.

## 4. Register it

In `src/samples/mod.rs`: add an `AppState` variant, a row in `all()` (order =
menu order), and the plugin in `register_samples()`.

## 5. Add a headless test

The Bevy DoD requires at least one `#[test]` using `MinimalPlugins` (no window, no
GPU) that asserts the mechanic's logic:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn does_the_thing() {
        let mut app = App::new();
        app.add_plugins(MinimalPlugins);
        // spawn inputs, app.update(), assert the resulting state
    }
}
```

This is the agent's primary verification path — prefer it over opening the window.

## 6. Verify (the gate)

```bash
cargo check    # MUST pass — fast verify (no codegen/link); use this in the loop
cargo test     # headless logic tests pass
cargo clippy   # lints clean
cargo run --features bevy/dynamic_linking   # eyeball it (fast incremental run)
```

A red `cargo check` blocks the next sample. **One issue = one PR = `cargo check`
green + a headless test.**
