@REVIEW.md

# three-playground

A growing collection of self-contained **Three.js** samples that reproduce game mechanics and let us judge how each one *feels* (操作性 / control responsiveness). Built so Claude Code's `/dev-all` can autonomously add more samples from GitHub Issues — one issue per sample (or per sub-mechanic).

This is the sibling of `babylon-playground`: the **same sample lineup** is built in both engines for an apples-to-apples comparison.

## Build & Run

```bash
npm install
npm run dev        # Vite dev server (hot reload) — open the printed localhost URL
npm run build      # tsc --noEmit && vite build  (MUST stay green)
npm run typecheck  # tsc --noEmit
npm run lint       # eslint .
```

## Project Structure

```
src/
  main.ts            — gallery shell: lists samples, hash-routing (#/<sample-id>)
  style.css
  engine/
    bootstrap.ts     — creates the WebGLRenderer + render loop + resize; fresh Scene + Camera per sample
  samples/
    types.ts         — Sample + SampleContext interfaces (THE contract)
    registry.ts      — array of all samples (import + register here)
    01-character-controller/  { index.ts, README.md }
    02-physics-grab-throw/    { index.ts, README.md }
    03-paint-on-mesh/         { index.ts, README.md }
docs/
  SAMPLES.md         — backlog catalog (each row → one GitHub issue)
  ADDING-A-SAMPLE.md — step-by-step contract for adding a sample
.claude/             — AI-dev harness (skills: dev, dev-all, review, pr, dig, decompose, ...)
```

## Core Values

Max 3. Every change must directly strengthen one of these (one-step test, no indirect reasoning).

1. **Faithful mechanic reproduction with honest feel notes.** Each sample reproduces a real game mechanic AND its README records how it actually *feels* (responsiveness, latency, jank) — the goal is judgment, not a tech demo. Document bad feel too.
2. **Idiomatic Three.js, minimal dependencies.** Three is a rendering library — compose small focused libraries (e.g. Rapier for physics) rather than pulling a framework. Samples must read as clean references.
3. **AI-Agent Developable.** Everything is code — no GUI/scene editor. Every sample is self-contained in one folder, registered in one place, and `npm run build`-green.

## Won't Do

- **GUI / visual scene editor** — code-first only (breaks Core Value 3).
- **Bespoke hand-made 3D art** — primitives / procedural / CC0 only. This playground tests *mechanics*, not art.
- **Networking / multiplayer** — single-machine mechanic verification only. Netcode is a separate spike.
- **Mobile build** — target is desktop browser (→ Electron/Tauri for Steam). This genre is PC/Steam-first.

## Tech Stack

| Layer | Technology |
|---|---|
| Language | TypeScript (strict) |
| Renderer | Three.js (`three`) |
| Physics | Rapier (`@dimforge/rapier3d-compat`) |
| Bundler / dev server | Vite |
| Lint | ESLint + typescript-eslint |
| Runtime target | Desktop browser (→ Electron/Tauri for Steam) |

## Adding a Sample (the contract `/dev-all` follows)

1. Create `src/samples/NN-name/index.ts` exporting a `Sample` (see `src/samples/types.ts`):
   `{ id, title, summary, tags, mount(ctx) { /* ... */ return dispose } }`.
2. Implement the mechanic inside `mount(ctx)` using `ctx.scene` / `ctx.camera` / `ctx.renderer` / `ctx.canvas`. Return a **dispose** function that removes every listener and disposes geometries/materials you created (no leaks between samples).
3. Register it in `src/samples/registry.ts`.
4. Write `src/samples/NN-name/README.md`: **What it demonstrates / Controls / Feel & difficulty notes / Three.js gotchas.**
5. `npm run build` must pass.

Full walkthrough: `docs/ADDING-A-SAMPLE.md`.

## One Issue = One PR (sizing for autonomous dev)

- Each issue is a single coherent change that leaves `main` build-green = exactly one PR.
- If a sample needs a new shared helper, split the helper into its own issue first and link it (`depends on #N`) so `/dev-all` orders it first.
- The Definition of Done lives in `.github/ISSUE_TEMPLATE/sample.md`.

## Think Twice

- Does the sample actually *demonstrate the mechanic*, or just render something?
- Is the feel honestly documented (including where it feels bad)?
- Edge cases: window resize; sample dispose (no leaked listeners / undisposed GPU resources); rapid sample switching.
- `npm run build` green? No `any` without a reason?

## Language

- Code comments & identifiers: English.
- Commits: concise single line, English.
