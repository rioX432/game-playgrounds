# three-playground

A **Three.js** game-mechanics playground — a growing collection of self-contained samples that verify what Three.js can do and, just as importantly, how each mechanic actually *feels*. Sibling of `babylon-playground` (same sample lineup, different engine). New samples are added autonomously from GitHub Issues via Claude Code's `/dev-all`.

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

### Auto-measure mode & renderer switch

- `?measure=1` turns on **auto-measure mode** (OFF for normal play): it spawns a seeded, deterministic stress scene and records raw `requestAnimationFrame` present-to-present deltas → p50/p95/p99 + longFrameCount. Full URL contract: `?sample=13-stress-bodies&bodies=2000&measure=1&seed=N&warmupMs=...&windowMs=...&renderer=webgl|webgpu` (parsed by `src/measure/config.ts`).
- `?renderer=` selects the renderer: absent = the classic `WebGLRenderer`; `webgpu` = `WebGPURenderer` (WebGPU backend); `webgl` = `WebGPURenderer`'s WebGL2 fallback. The `three/webgpu` path is a separate dynamic import (`src/engine/webgpu/`) so `three` core and `three/webgpu` never share one module graph (duplicate-class hazard).
- Measured results: [`../COMPARISON.md`](../COMPARISON.md) §5.1 / §9.

## Docs

- `docs/SAMPLES.md` — the catalog of built samples (all 12 mechanics, with links)
- `docs/ADDING-A-SAMPLE.md` — step-by-step contract for adding a sample
- `CLAUDE.md` — project rules, Core Values, Won't Do
- [`../COMPARISON.md`](../COMPARISON.md) — cross-engine findings (Three vs Babylon vs Bevy)

## Stack

TypeScript (strict) · Three.js · Rapier · Vite · ESLint
