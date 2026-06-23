# Sample Catalog — bevy-playground

**engine: bevy** (`bevy 0.18` + `bevy_rapier3d 0.34`)

All samples in the shared cross-engine lineup are **built and `cargo check`-green**,
each with at least one headless `#[test]`. This file is the catalog of what exists;
the same lineup is implemented in `../three` and `../babylon`. For the cross-engine
findings, see [`../../COMPARISON.md`](../../COMPARISON.md).

Each sample is one module `src/samples/sNN_name.rs` whose module-doc header
(`//! ...`) records *What it demonstrates / Controls / Feel notes / Bevy 0.18 gotchas*.

## Samples

| # | Sample | Module | What it shows |
|---|--------|--------|---------------|
| 01 | Character Controller | [`s01_character_controller.rs`](../src/samples/s01_character_controller.rs) | Transform-based capsule: camera-relative WASD, mouse-look, Space jump + gravity, orbit follow camera |
| 02 | Physics Grab & Throw | [`s02_physics_grab_throw.rs`](../src/samples/s02_physics_grab_throw.rs) | Rapier raycast grab → velocity-spring hold → throw by impulse |
| 03 | Paint on Mesh | [`s03_paint_on_mesh.rs`](../src/samples/s03_paint_on_mesh.rs) | Runtime-editable `Image`, painted at the hit UV |
| 04 | First-Person Controller | [`s04_first_person_controller.rs`](../src/samples/s04_first_person_controller.rs) | FPS move + pointer-lock look (yaw-relative) |
| 05 | Spatial Audio — Proximity Falloff | [`s05_spatial_audio.rs`](../src/samples/s05_spatial_audio.rs) | Custom `Decodable` source + distance attenuation |
| 06 | Hide & Seek — Prop Disguise | [`s06_hide_and_seek.rs`](../src/samples/s06_hide_and_seek.rs) | Swap `Mesh3d`/`MeshMaterial3d` to blend into props |
| 07 | Ragdoll | [`s07_ragdoll_core.rs`](../src/samples/s07_ragdoll_core.rs) | Jointed capsules flop under gravity; click to punch, R to reset |
| 08 | Red Light, Green Light | [`s08_red_light_green_light.rs`](../src/samples/s08_red_light_green_light.rs) | だるまさんがころんだ state machine + motion check |
| 09 | Co-op Carry | [`s09_coop_carry.rs`](../src/samples/s09_coop_carry.rs) | Plank jointed to two carriers (one P-controlled follower) |
| 10 | Emote / Pose Radial Wheel | [`s10_emote_wheel.rs`](../src/samples/s10_emote_wheel.rs) | Bevy-UI radial wheel → apply a procedural pose |
| 11 | Top-Down Twin-Stick Movement | [`s11_top_down_twin_stick.rs`](../src/samples/s11_top_down_twin_stick.rs) | Decoupled move + cursor aim (free cursor, no pointer-lock) |
| 12 | Tiny Planet | [`s12_tiny_planet.rs`](../src/samples/s12_tiny_planet.rs) | Spherical gravity + walk-on-sphere + props + damped follow camera |

## Shared foundation (`src/engine/`)

Added once in `main.rs`; samples read its resources:

- `input.rs` — `FoundationInputPlugin`: `MoveIntent` / `LookState` + pointer-lock.
- `scene.rs` — `spawn_ground`, `spawn_light_preset`, `spawn_box_grid`.
- `hud.rs` — controls overlay + FPS (`FrameTimeDiagnosticsPlugin`).

## How this was built (AI-dev record)

Each sample was one GitHub Issue → one PR, kept `cargo check`-green with a headless
`#[test]`, driven by Claude Code's `/dev-all`. Foundation plugins landed first;
heavy samples (ragdoll, tiny-planet) were split into `core` + `polish` issues.
APIs are pinned to **Bevy 0.18** against the reference project `avvy-world`; the
authoring contract and 0.18 gotchas live in [`../CLAUDE.md`](../CLAUDE.md).

> **Code size note:** the Bevy samples total ~5,900 LOC (avg ~490/sample) versus
> ~3,760 (Three) / comparable (Babylon) for the same mechanics — the cost of
> explicit types, ECS plugin/system wiring, and Rapier setup. See
> [`../../COMPARISON.md`](../../COMPARISON.md).
