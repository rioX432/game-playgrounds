# babylon-playground

A **Babylon.js game-mechanics playground** — a growing collection of
self-contained samples that verify what Babylon.js can do and, just as
importantly, how each mechanic actually *feels* (操作性). Built with Vite +
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

## Seed samples

| # | Sample | What it shows |
|---|--------|---------------|
| 01 | Third-person character controller | Kinematic capsule, pointer-lock look, jump, follow camera |
| 02 | Physics grab & throw (Havok) | Raycast grab/hold/throw of dynamic rigid bodies |
| 03 | Paint on mesh | Painting onto a `DynamicTexture` via picked UVs |

Each sample folder has a `README.md` covering **what it demonstrates / controls /
feel & difficulty notes / Babylon-specific gotchas**.

## Docs

- [`CLAUDE.md`](CLAUDE.md) — project values, structure, rules (read first).
- [`docs/ADDING-A-SAMPLE.md`](docs/ADDING-A-SAMPLE.md) — how to author a new sample.
- [`docs/SAMPLES.md`](docs/SAMPLES.md) — the backlog catalog (future issues).

## Won't do

No GUI editor, no hand-made art (primitives/procedural only), no
networking/multiplayer, no mobile build. This playground verifies single-machine
mechanics and their feel.
