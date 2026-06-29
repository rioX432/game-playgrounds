# babylon-playground

A **Babylon.js game-mechanics playground** — a growing collection of
self-contained samples that verify what Babylon.js can do and, just as
importantly, how each mechanic actually *feels*. Built with Vite +
TypeScript (strict). New samples are added autonomously from GitHub issues via
Claude Code's `/dev-all` skill.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
```

Other scripts:

```bash
npm run build      # tsc --noEmit && vite build (the green gate)
npm run typecheck  # tsc --noEmit
npm run lint       # eslint .
npm run preview    # preview a production build
```

## How samples work

The gallery boots a single Babylon `Engine` on the `#app` canvas. The left
sidebar lists every registered sample; clicking one disposes the previous scene
and mounts the new one into a fresh `Scene`. Samples are deep-linkable via the URL
hash (`#/<sample-id>`).

Each sample is a self-contained folder under `src/samples/` that implements one
small interface:

```ts
interface Sample {
  id: string;
  title: string;
  summary: string;
  tags: string[];
  mount(ctx: SampleContext): void | (() => void); // returned fn disposes
}
```

`mount` builds the mechanic into `ctx.scene`; the optional returned function
cleans up listeners/overlay DOM when the user switches away.

### Auto-measure mode & renderer switch

`?measure=1` turns on **auto-measure mode** (OFF for normal play): it spawns a
seeded, deterministic stress scene and records raw `requestAnimationFrame`
present-to-present deltas → p50/p95/p99 + longFrameCount. Full URL contract:
`?sample=13-stress-bodies&bodies=2000&measure=1&seed=N&warmupMs=...&windowMs=...&renderer=webgl|webgpu`
(parsed by `src/measure/config.ts`). `?renderer=webgpu` runs the scene on a
`WebGPUEngine` (`src/engine/measureWebgpu.ts`); absent or `webgl` uses the
classic `Engine` — both come from `@babylonjs/core`, so no dual-module-graph
hazard. Measured results: [`../COMPARISON.md`](../COMPARISON.md) §5.1 / §9.

## Samples

All 12 mechanics in the shared lineup are implemented. Each folder has a
`README.md` covering **what it demonstrates / controls / feel & difficulty notes
/ Babylon-specific gotchas**.

| # | Sample | What it shows |
|---|--------|---------------|
| 01 | [Character Controller](src/samples/01-character-controller) | Kinematic capsule, pointer-lock look, jump, follow camera |
| 02 | [Physics Grab & Throw](src/samples/02-physics-grab-throw) | Havok raycast grab / hold / throw of dynamic bodies |
| 03 | [Paint on Mesh](src/samples/03-paint-on-mesh) | Painting onto a `DynamicTexture` via picked UVs (disguise core) |
| 04 | [First-Person Controller](src/samples/04-first-person-controller) | FPS move + pointer-lock look + jump |
| 05 | [Spatial Audio — Proximity Falloff](src/samples/05-spatial-audio) | Positional audio distance attenuation (proximity-voice feel) |
| 06 | [Hide & Seek — Prop Disguise](src/samples/06-hide-and-seek-disguise) | Cycle your form to blend into props; moving breaks the disguise |
| 07 | [Ragdoll](src/samples/07-ragdoll-core) | Jointed capsule humanoid flops under gravity; click to punch, R to reset |
| 08 | [Red Light, Green Light](src/samples/08-red-light-green-light) | だるまさんがころんだ state machine + motion check |
| 09 | [Co-op Carry](src/samples/09-coop-carry) | Carry a plank jointed to two carriers; out-of-sync motion sways it |
| 10 | [Emote / Pose Radial Wheel](src/samples/10-emote-wheel) | Hold to open a radial wheel, aim to pick, release to play the pose |
| 11 | [Top-Down Twin-Stick](src/samples/11-top-down-twin-stick) | Decoupled move + aim (strafe while aiming elsewhere) |
| 12a | [Spherical Gravity](src/samples/12a-spherical-gravity) | Walk on a sphere; up aligns to the surface normal |
| 12b | [Tiny Planet](src/samples/12b-tiny-planet) | Tiny-planet scene + damped follow camera (Mario Galaxy feel) |

See [`docs/SAMPLES.md`](docs/SAMPLES.md) for the full catalog and
[`../COMPARISON.md`](../COMPARISON.md) for the cross-engine findings.

## Docs

- [`CLAUDE.md`](CLAUDE.md) — project values, structure, rules (read first).
- [`docs/ADDING-A-SAMPLE.md`](docs/ADDING-A-SAMPLE.md) — how to author a new sample.
- [`docs/SAMPLES.md`](docs/SAMPLES.md) — the catalog of built samples (all 12).

## Won't do

No GUI editor, no hand-made art (primitives/procedural only), no
networking/multiplayer, no mobile build. This playground verifies single-machine
mechanics and their feel.
