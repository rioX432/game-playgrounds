# web-on-steam — Layer 2 (Electron host overhead) measurements

Raw evidence for COMPARISON.md §9 (written up in PR6 / #176). Layer 2 = the
**distribution-host overhead** of wrapping the web build for Steam; Layer 1 (the
renderer ceiling itself) is the in-browser frame-time from PR1–PR3.

## Files

`electron-{three,babylon}-{webgl,webgpu}.jsonl` — one file per engine × backend.
Each file is the body-count ramp `100, 500, 1000, 1500, 2000`. Per body count:

- **3 `RenderSample` lines** (the measurement windows) — same schema as the browser
  sidecar (`engine`, `renderer`, `backend`, `bodies`, `seed`, `frameTimeP50/95/99Ms`,
  `longFrameCount`, `fpsMean`, `sampleWindowMs`, `frameCount`) — but with **`host`
  overridden to `"electron"`** by the runner (the in-page probe stamps `"browser"`
  because it can't know its shell; the runner is the host source of truth).
- **1 `overhead` line** (`kind:"overhead"`): `ramRssKbProcessTree`, `processCount`,
  `timeToFirstSampleMs`, `windowsCaptured`, `ua`.

## How they were produced

Single machine: Apple M3 Pro, macOS 26.6, Metal 4. Electron 33.4.11 (Chromium 130).
Same `seed=12345`, `warmupMs=1000`, `windowMs=1500`, `maxWindows=3` as the browser
(PR1) runs, so Electron and browser join on `engine`+`backend`+`bodies`+`seed`.

```bash
# Build the web apps with a RELATIVE base so file:// resolves Vite's asset URLs:
cd three   && npm run build -- --base=./
cd babylon && npm run build -- --base=./

# Run the matrix (per engine × backend). The runner launches the Electron shell on the
# 13-stress auto-measure URL, harvests window.__renderSamples over CDP, and samples the
# process-tree RAM + cold-start. See packaging/electron/measure.mjs. (Numeric knobs left
# at the runner's defaults — SEED=12345, WARMUP_MS=1000, WINDOW_MS=1500, MAX_WINDOWS=3,
# BODIES=100,500,1000,1500,2000 — are passed explicitly below for reproducibility.)
cd packaging/electron
M="../../net/measurements/web-on-steam"
SEED=12345 WARMUP_MS=1000 WINDOW_MS=1500 MAX_WINDOWS=3 BODIES=100,500,1000,1500,2000 WEB_DIST=../../three/dist   ENGINE=three   BACKEND=webgl  PORT=9340 OUT=$M/electron-three-webgl.jsonl    node measure.mjs
SEED=12345 WARMUP_MS=1000 WINDOW_MS=1500 MAX_WINDOWS=3 BODIES=100,500,1000,1500,2000 WEB_DIST=../../three/dist   ENGINE=three   BACKEND=webgpu PORT=9350 OUT=$M/electron-three-webgpu.jsonl   node measure.mjs
SEED=12345 WARMUP_MS=1000 WINDOW_MS=1500 MAX_WINDOWS=3 BODIES=100,500,1000,1500,2000 WEB_DIST=../../babylon/dist ENGINE=babylon BACKEND=webgl  PORT=9360 OUT=$M/electron-babylon-webgl.jsonl  node measure.mjs
SEED=12345 WARMUP_MS=1000 WINDOW_MS=1500 MAX_WINDOWS=3 BODIES=100,500,1000,1500,2000 WEB_DIST=../../babylon/dist ENGINE=babylon BACKEND=webgpu PORT=9370 OUT=$M/electron-babylon-webgpu.jsonl node measure.mjs
```

## Distribution-overhead summary (this run)

| Metric | three | babylon |
|---|---|---|
| RAM (process-tree RSS) @100 → 2000 bodies | ~485 → 615 MB | ~470 → 567 MB |
| Process count (npm-shim/main + renderer + GPU + 2 helpers) | 5 | 5 |
| Cold-start (spawn → first measured window) | ~3.0–3.4 s | ~3.4–3.5 s |
| Installer (DMG, unsigned) | 96 MB | ≈ 96 MB (web bundle delta only) |
| Installed footprint (`.app`) | 237 MB | ≈ 237 MB (web bundle delta only) |

The DMG/`.app` were built with `CSC_IDENTITY_AUTO_DISCOVERY=false WEB_DIST=../../three/dist npm run dist`.
The Electron runtime dominates both sizes, so the babylon bundle (~5 MB vs three's ~3 MB)
moves them by only a couple MB — measured once on three and noted, not re-packaged per engine.

## Honest caveats (read before diffing)

- **vsync-bound medians.** With vsync ON (the realistic Steam-app default) on a 120 Hz
  ProMotion panel, frame-time medians sit at ~8.3 ms (120 fps) for ≤2000 bodies on this
  GPU — the M3 Pro isn't saturated by 2000 boxes. The cross-backend / cross-host signal is
  therefore in the **tail (p99) and `longFrameCount`**, not the median (the §9 vsync-tail
  point). Higher body counts would be needed to push the median off the vsync cap.
- **RAM = summed RSS of the process tree.** RSS counts shared framework pages per process,
  so the tree sum slightly over-counts shared memory — it's an honest *upper-ish* bound,
  but it is measured identically for every host, so host-to-host deltas are fair.
- **Cold-start** is `spawn → first completed measurement window`, i.e. it includes page
  load + engine init + warmup + one window — not an isolated first-frame time. Measured
  identically across hosts for comparability.
- **Single machine, attended.** Not a fleet/throughput benchmark — per the chapter scope
  (CLAUDE.md "Won't Do": no real-scale / viral-load infra).
- **WebGPU in Electron = GO** (bundled Chromium 130), unlike Tauri's OS-gated WKWebView
  path — see `docs/web-on-steam/PR0-webgpu-availability.md`.
