@REVIEW.md

# babylon-playground

A Babylon.js game-mechanics playground: a growing collection of self-contained
samples that verify what Babylon.js can do and — just as importantly — how each
mechanic actually *feels* (操作性). New samples are added autonomously from GitHub
Issues via Claude Code's `/dev-all` skill.

## Build & Run

```bash
# Prerequisites: Node 22 + npm
npm install

# Dev server (Vite, http://localhost:5173)
npm run dev

# Production build (type-checks, then bundles) — must stay green
npm run build

# Type-check only
npm run typecheck

# Lint
npm run lint

# Preview a production build
npm run preview
```

## Project Structure

```
babylon-playground/
├── index.html               — single canvas (#app) + module entry
├── src/
│   ├── main.ts              — gallery: sidebar, overlay, hash routing
│   ├── style.css            — gallery + sample-overlay styling
│   ├── engine/
│   │   ├── bootstrap.ts     — Playground: one Engine, render loop, scene switching
│   │   └── havok.ts         — load Havok WASM once, hand back a HavokPlugin
│   └── samples/
│       ├── types.ts         — Sample + SampleContext contract
│       ├── registry.ts      — Sample[] the gallery renders
│       ├── 01-character-controller/   — index.ts + README.md
│       ├── 02-physics-grab-throw/     — index.ts + README.md
│       └── 03-paint-on-mesh/          — index.ts + README.md
├── docs/
│   ├── ADDING-A-SAMPLE.md   — step-by-step authoring guide
│   └── SAMPLES.md           — backlog catalog (each row = a future issue)
└── .claude/                 — AI-dev harness (skills, agents, rules, hooks)
```

## Core Values

1. **Faithful mechanic reproduction with honest feel/操作性 notes.** Every sample
   reproduces a real game mechanic and documents how it *actually feels* — snappy
   vs. floaty, responsive vs. laggy, the tuning constants that matter. A sample
   that runs but lies about its feel is a failed sample.
2. **Idiomatic Babylon.js, minimal dependencies.** Use Babylon's own APIs
   (FollowCamera, PhysicsAggregate, DynamicTexture, pointer observables) the way
   the docs intend. No wrapper frameworks, no UI library; plain DOM for the gallery.
3. **AI-Agent Developable.** Code-first — no GUI/visual editor. Every sample is
   self-contained in its own folder, implements the `Sample` contract, and the
   repo stays `npm run build`-green at all times so an agent can add the next one.

## Won't Do

- No GUI / visual scene editor — everything is code.
- No bespoke hand-made art — primitives and procedural meshes/textures only.
- No networking / multiplayer — this playground verifies mechanics on a single
  machine. Multiplayer feel belongs in a different project.
- No mobile build — desktop browser only.

## Tech Stack

| Component | Technology | Notes |
|-----------|-----------|-------|
| Language | TypeScript (strict) | target ES2022, `moduleResolution: bundler` |
| 3D engine | @babylonjs/core | tree-shaken side-effect imports |
| Physics | @babylonjs/havok (Physics v2) | WASM, loaded once via `engine/havok.ts` |
| Inspector | @babylonjs/inspector | dev-only debugging aid |
| Bundler / dev server | Vite | port 5173 |
| Lint | ESLint + typescript-eslint | flat config |
| Runtime | Node 22 / npm | — |

## Adding a Sample

This is the loop `/dev-all` repeats. Full detail in `docs/ADDING-A-SAMPLE.md`.

1. **Create a folder** `src/samples/NN-kebab-name/` with `index.ts` + `README.md`.
2. **Implement the `Sample` contract** (`src/samples/types.ts`):
   - `id` (kebab-case, also the `#/<id>` deep link), `title`, `summary`, `tags`.
   - `mount(ctx: SampleContext)` builds the scene into `ctx.scene` and may return a
     dispose function. The dispose fn must remove every DOM listener, pointer-lock
     handler, observable, and overlay element the sample added.
3. **Use `ctx`**: `ctx.engine` (shared, long-lived), `ctx.scene` (fresh per sample),
   `ctx.canvas`. Do **not** create your own Engine or render loop.
4. **Register it** in `src/samples/registry.ts` (`import` + add to `samples[]`).
5. **Write the README** with the four required sections: *What it demonstrates /
   Controls / Feel & difficulty notes / Babylon-specific gotchas.*
6. **Keep it green**: `npm run typecheck`, `npm run lint`, and `npm run build`
   must all pass before the work is done.

## Coding Rules

1. TypeScript `strict` is on. No `any` without a `// reason:` comment explaining why.
2. Code comments and identifiers are **English**.
3. Tree-shaken imports: import from `@babylonjs/core/<path>` (not the barrel) and
   add side-effect imports (e.g. `@babylonjs/core/Meshes/Builders/boxBuilder`) for
   builders/components you use.
4. A sample owns its cleanup. If `mount` adds a listener/observer/DOM node, the
   returned dispose fn removes it. Scene-bound observables are torn down when the
   scene is disposed, but window/document listeners are not.
5. Never instantiate a second `Engine` or call `runRenderLoop` from a sample.
6. No networking, no asset downloads — primitives and procedural content only.

## Think Twice

- **Async setup vs. disposal race.** Havok (and any async load) can finish after
  the user already switched away. Guard with a `disposed` flag (see sample 02).
- **DOM leaks across samples.** The overlay (`#overlay`) is shared. Anything a
  sample appends there must be removed in its dispose fn, or it bleeds into the
  next sample.
- **Pointer lock / camera control conflicts.** `attachControl` and manual
  pointer-lock look can fight each other; pick one input model per sample.
- **`npm run build` is the gate.** A red build blocks the next `/dev-all` sample.
  Type errors in one sample break the whole gallery — keep samples isolated.

## Language

Code, comments, identifiers, and docs in this repo are **English**. Chat/PR
discussion with the maintainer may be Japanese.

@.claude/rules/behavior.md
@.claude/rules/coding-conventions.md
@.claude/rules/ai-ops.md
