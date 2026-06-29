# Sample Catalog — babylon-playground

All samples in the shared cross-engine lineup are **built and `npm run build`-green**.
This file is the catalog of what exists; the same lineup is implemented in
`../three` and `../bevy`. For the cross-engine findings, see
[`../../COMPARISON.md`](../../COMPARISON.md).

Each sample lives in `src/samples/<id>/` with its own `README.md`
(*What it demonstrates / Controls / Feel & difficulty notes / Babylon-specific gotchas*).
Deep-link any sample in the gallery via `#/<id>`.

## Samples

| # | Sample | Folder | What it shows |
|---|--------|--------|---------------|
| 01 | Character Controller | [`01-character-controller`](../src/samples/01-character-controller) | Third-person capsule: WASD move, pointer-lock look, jump, follow camera |
| 02 | Physics Grab & Throw | [`02-physics-grab-throw`](../src/samples/02-physics-grab-throw) | Havok raycast grab / hold at distance / throw by impulse |
| 03 | Paint on Mesh | [`03-paint-on-mesh`](../src/samples/03-paint-on-mesh) | Paint onto a `DynamicTexture` via the picked UV (the disguise core) |
| 04 | First-Person Controller | [`04-first-person-controller`](../src/samples/04-first-person-controller) | FPS move + pointer-lock look + jump |
| 05 | Spatial Audio — Proximity Falloff | [`05-spatial-audio`](../src/samples/05-spatial-audio) | Positional audio distance attenuation (proximity-voice feel) |
| 06 | Hide & Seek — Prop Disguise | [`06-hide-and-seek-disguise`](../src/samples/06-hide-and-seek-disguise) | Cycle your form to blend into props; moving breaks the disguise |
| 07 | Ragdoll | [`07-ragdoll-core`](../src/samples/07-ragdoll-core) | Jointed capsule humanoid flops under gravity; click to punch, R to reset |
| 08 | Red Light, Green Light | [`08-red-light-green-light`](../src/samples/08-red-light-green-light) | Move only when the doll faces away; caught if it sees you move |
| 09 | Co-op Carry | [`09-coop-carry`](../src/samples/09-coop-carry) | Plank jointed to two carriers; out-of-sync motion sways and tilts it |
| 10 | Emote / Pose Radial Wheel | [`10-emote-wheel`](../src/samples/10-emote-wheel) | Hold to open a radial wheel, aim to pick a sector, release to play the pose |
| 11 | Top-Down Twin-Stick Movement | [`11-top-down-twin-stick`](../src/samples/11-top-down-twin-stick) | Decoupled move + aim — strafe while aiming elsewhere |
| 12a | Spherical Gravity | [`12a-spherical-gravity`](../src/samples/12a-spherical-gravity) | Walk on a sphere; up aligns to the surface normal |
| 12b | Tiny Planet | [`12b-tiny-planet`](../src/samples/12b-tiny-planet) | Tiny-planet scene + damped follow camera |
| 13 | Stress / Load Harness | [`13-stress-bodies`](../src/samples/13-stress-bodies) | Spawn batches of dynamic boxes; live `ms/frame` readout (cross-engine perf probe) |
| 14 | Navmesh Pathfind + Dynamic Re-path | [`14-navmesh-pathfind`](../src/samples/14-navmesh-pathfind) | Agent walks A→B over a Recast/Detour navmesh; a wall drops mid-route and the path rebuilds to detour the gap |

> Sample 12 is split into **12a** (spherical-gravity core) and **12b** (tiny-planet
> scene + camera polish), matching the core/polish issue split.

## Shared foundation (`src/engine/`)

Built first so every later sample stays small:

- `input.ts` — keyboard state + pointer-lock mouse look.
- `hud.ts` — controls overlay + FPS counter.
- `scene.ts` / `prims.ts` — ground, box grid, light preset.
- `havok.ts` — load the Havok WASM once, hand back a `HavokPlugin`.

## How this was built (AI-dev record)

Each sample was one GitHub Issue → one PR, kept `npm run build`-green, driven by
Claude Code's `/dev-all`. Foundation helpers landed first; heavy samples (ragdoll,
tiny-planet) were split into `core` + `polish` issues. New mechanics follow the
same contract — see [`ADDING-A-SAMPLE.md`](ADDING-A-SAMPLE.md).
