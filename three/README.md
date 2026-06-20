# three-playground

A **Three.js** game-mechanics playground — a growing collection of self-contained samples that verify what Three.js can do and, just as importantly, how each mechanic actually *feels* (操作性). Sibling of `babylon-playground` (same sample lineup, different engine). New samples are added autonomously from GitHub Issues via Claude Code's `/dev-all`.

## Quick start

```bash
npm install
npm run dev        # Vite dev server → http://localhost:5173
npm run build      # tsc --noEmit && vite build (must stay green)
npm run typecheck
npm run lint
```

## How it works

- The **gallery shell** (`src/main.ts`) lists every sample in a sidebar; click one (or deep-link `#/<sample-id>`) to mount it on the shared canvas.
- Each sample lives in `src/samples/<NN-name>/` and implements the `Sample` interface (`src/samples/types.ts`), registered in `src/samples/registry.ts`.
- Rendering: **Three.js**. Physics: **Rapier** (`@dimforge/rapier3d-compat`).

## Docs

- `docs/SAMPLES.md` — the backlog (each row = one GitHub issue = one PR)
- `docs/ADDING-A-SAMPLE.md` — step-by-step contract for adding a sample
- `CLAUDE.md` — project rules, Core Values, Won't Do

## Stack

TypeScript (strict) · Three.js · Rapier · Vite · ESLint
