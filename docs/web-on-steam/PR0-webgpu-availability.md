# Ch3 / PR0 — WebGPU availability spike (browser / Electron / Tauri × Three / Babylon)

> Issue #170. **Spike — no performance numbers**, only go/no-go availability and the
> Three.js `three/webgpu` import policy that PR2 depends on. Measured on real hardware
> per Core Value #1 ("faithful … honest feel notes"); fabricated results are explicitly
> out of scope ("fake しない").

## Environment (Apple Silicon)

| | |
|---|---|
| Machine | Apple M3 Pro, Metal 4, arm64 |
| OS | macOS 26.6 (build 25G5043d) |
| three | `three@0.169.0` |
| babylon | `@babylonjs/core@7.54.0` |
| Browser host | Google Chrome 149 (real GPU, driven via CDP) |
| Electron host | `electron@33.4.11` → Chromium 130.0.6723.191 (bundled) |
| Tauri host | WKWebView / WebKit 605.1.15 on macOS 26.6 (system webview) |

**Windows WebView2 is untested** (no Windows hardware in this spike). Tauri's Windows
path bundles a Chromium-based WebView2 and is expected to behave like Electron/Chromium,
but that is **not measured here**.

## Method (honest, per host)

Each cell runs the same logical probe: `navigator.gpu → requestAdapter → requestDevice →
draw 1 real frame`, plus a renderer-specific 1-frame render where applicable.

- **Browser**: real Google Chrome launched with `--remote-debugging-port`, a `file://`
  probe page read back over CDP (`Runtime.evaluate window.__probe`). Three is imported
  from `three@0.169.0/webgpu`, Babylon from `@babylonjs/core@7.54.0` (pinned to the
  versions installed in the repo). Real GPU (Metal), **not** SwiftShader.
- **Electron**: the existing `packaging/electron` (`electron@33.4.11`), a hidden
  `BrowserWindow` loading the same probe page, result harvested via
  `webContents.executeJavaScript`.
- **Tauri / WKWebView**: a minimal Swift `WKWebView` harness (default
  `WKWebViewConfiguration`) loading a **raw-WebGPU-only** probe page (no CDN imports — a
  `file://` page in WKWebView cannot fetch cross-origin ES modules, a WebKit
  same-origin restriction that does **not** apply to a real Tauri app, which serves its
  bundled assets from a custom protocol / localhost). The authoritative WKWebView signal
  is therefore the raw `navigator.gpu → adapter → device → 1 frame` path.

## go/no-go matrix

| Host | renderer | `navigator.gpu` | adapter | device | 1 frame | **verdict** |
|------|----------|:---:|:---:|:---:|:---:|:---:|
| **Browser** (Chrome 149) | raw WebGPU | ✅ | ✅ | ✅ | ✅ | **GO** |
| Browser | Three r169 (`three/webgpu`) | — | — | — | ✅ `renderAsync` | **GO** |
| Browser | Babylon 7.54 (`WebGPUEngine`) | — | — | — | ✅ `render` | **GO** |
| **Electron** (Chromium 130) | raw WebGPU | ✅ | ✅ | ✅ | ✅ | **GO** |
| Electron | Three r169 | — | — | — | ✅ | **GO** |
| Electron | Babylon 7.54 | — | — | — | ✅ | **GO** |
| **Tauri / WKWebView** (macOS 26.6) | raw WebGPU | ✅ | ✅ | ✅ | ✅ | **GO\*** |
| Tauri / WKWebView | Three / Babylon | — | — | — | inferred | **GO\* (not directly tested — see caveat)** |

Raw probe results, verbatim:

- Browser: `{hasNavigatorGpu:true, raw:{adapter:true,device:true,drewFrame:true}, three:{ok:true,version:"169"}, babylon:{ok:true,version:"7.54.0"}}`
- Electron: `{hasNavigatorGpu:true, raw:{adapter:true,device:true,drewFrame:true}, three:{ok:true}, babylon:{ok:true}}` (Chromium 130.0.6723.191 / Electron 33.4.11)
- WKWebView: `{hasNavigatorGpu:true, adapter:true, device:true, drewFrame:true, error:null}` (WebKit 605.1.15, macOS 26.6)

## Tauri / WKWebView verdict — GO on macOS 26+, with hard caveats

WebGPU in WKWebView **works by default on macOS 26.6** — measured here, real GPU, one
frame drawn. This is consistent with the Tauri maintainers' own statements in
[tauri-apps/tauri#6381](https://github.com/tauri-apps/tauri/issues/6381):

- 2023 → early 2025: **not possible** in WKWebView — "You can't enable feature flags in
  WKWebView"; for WebGPU "we're better off with Electron" (FabianLars).
- 2025-09-12: if Apple ships WebGPU in WKWebView (not just Safari), Tauri gets it
  automatically, but **only on macOS 26+** (WKWebView is bound to the OS version, unlike
  Electron's bundled Chromium).
- 2025-11-24: maintainer **tested it working out of the box on macOS 26** (production
  build) — but reported **WebGPU fails to initialize in a *development* build**.

**Caveats that PR5 must carry forward:**

1. **OS-26-gated.** WKWebView WebGPU requires macOS 26+. A Steam build shipping Tauri +
   WebGPU reaches **only macOS 26+ users**; older macOS gets WebGL or nothing. Electron
   (bundled Chromium) has no such OS floor. → This is an **inevitable distribution gap**
   for COMPARISON.md §9 (Layer 2).
2. **dev vs. production build.** The maintainer reports WebGPU init failing in Tauri
   *dev* builds and succeeding in *production* builds. **PR5's WebGPU measurement must use
   a release build (`tauri build`), not `tauri dev`.**
3. **Harness boundary.** This spike measured the **WKWebView engine directly** (a Swift
   harness), not a full Tauri app shell. The engine-layer capability is GO; the
   Tauri-app-shell content-loading path (custom protocol, release packaging) is the one
   layer PR5 must confirm first, before trusting WebGPU numbers.

**PR5 decision: NOT "WebGL-only / no-go".** Build the Tauri shell, attempt WebGPU in a
**release build on macOS 26+**, and document the OS-26 floor + dev/prod nuance as honest
§9 gaps. Fall back to WebGL-only only if the release-build app-shell path actually fails.

## `three/webgpu` import policy (PR2 prerequisite) — Codex-verified

### Measured module-graph fact

- `three` → `three.module.js` (WebGL core, classic `WebGLRenderer`).
- `three/webgpu` **and** `three/tsl` both → `three.webgpu.js` — a **self-contained 1.6 MB
  bundle that re-bundles every core class** (Scene, Mesh, MeshBasicMaterial, …) plus
  `WebGPURenderer`, node materials, and TSL.
- ⇒ Importing core symbols from **both** `three` and `three/webgpu` in one module graph
  creates **two copies of every core class** → duplicate-instance bugs (`instanceof`
  fails; materials/geometries not recognized across the boundary). This is the classic
  "Multiple instances of Three.js" failure.

### Policy (recommendation B, Codex-confirmed)

1. **Single module graph.** Every WebGPU-capable sample imports **all** Three symbols
   (core + WebGPU + TSL) from `three/webgpu` / `three/tsl` — never from bare `three`.
   Route them through a local shim, e.g. `three/src/engine/three-runtime.ts`, so reviewers
   can grep for violations.
2. **`?renderer=webgl` in PR2 means `WebGPURenderer` on its WebGL2 fallback backend** —
   **not** the classic `WebGLRenderer`. `?renderer=webgpu` means `WebGPURenderer` on the
   WebGPU backend. One renderer family, one import graph; only the backend changes.
3. **Re-baseline — do not cross-compare with PR1.** PR1's WebGL baseline uses the classic
   `WebGLRenderer` (from `three`). PR2's `webgl` path uses `WebGPURenderer`'s WebGL2
   backend — a **different code path**. Recording them as the same "WebGL" number is a
   measurement confound. Label the resolved renderer distinctly, e.g.
   `three-webgpu/webgpu` vs `three-webgpu/webgl2-fallback`, and keep PR1's
   classic-`WebGLRenderer` number as a separately-labelled control, not the PR2 baseline.
   Internal mode names: `type RendererMode = 'webgpu' | 'webgpu-webgl2'`.
4. **Async init.** `WebGPURenderer` requires `await renderer.init()` before the loop and
   the async render path (`renderAsync`). Use an **async engine factory**
   (`createEngine(...): Promise<Engine>`); avoid top-level await. If TLA is unavoidable,
   set Vite `build.target: 'esnext'` (modern-desktop-only playground — fine to set anyway).

### PR2/PR3 review checklist (bake these in)

- [ ] No module imports runtime Three objects from **both** `three` and `three/webgpu`.
      WebGPU-capable sample graph imports Scene/Mesh/Material/Geometry/Color/Vector/… from
      the runtime shim or `three/webgpu` only.
- [ ] PR1's classic `WebGLRenderer` baseline stays separately labelled; it is **not** used
      as the PR2 backend-comparison baseline.
- [ ] Resolved renderer recorded as `three-webgpu/webgpu` vs `three-webgpu/webgl2-fallback`
      (no pretending the PR2 `webgl` path is PR1's classic path).
- [ ] `await renderer.init()` before first frame; async factory, no stray top-level await.

> Babylon (PR3) has no equivalent dual-module-graph hazard: `@babylonjs/core` exposes both
> `Engine` (WebGL) and `WebGPUEngine` from the **same** package, so the switch is a simple
> async branch (`WebGPUEngine.CreateAsync` / `initAsync`) without import-graph splitting.

## Acceptance criteria (issue #170)

- [x] host×renderer go/no-go table (Apple Silicon) recorded — this doc.
- [x] Tauri WebGPU verdict by measurement — **GO on macOS 26+** (WKWebView measured),
      with OS-26 floor + dev/prod + app-shell caveats; basis for PR5 being GO-with-caveats
      rather than no-go.
- [x] three WebGPU import unification policy memo (PR2 prerequisite) — above, Codex-verified.

## What this spike does NOT establish

- No performance numbers (out of scope; PR1+ measure those).
- Windows WebView2 untested (no Windows hardware).
- Tauri full-app-shell WebGPU not directly run (engine layer measured; release-build
  app-shell path is PR5's first task).
- WKWebView Three/Babylon renderer paths inferred from the raw-WebGPU GO + the
  browser/Electron renderer GO, not directly run under `file://` (WebKit cross-origin
  module restriction; a real Tauri app serves assets locally and avoids it).
