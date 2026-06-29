# net/tools — measurement harnesses

## `realGpuRender.mjs` — real-GPU client-render runner (#191)

Automates the **real-GPU** half of §8.7. The committed `*-client-render.jsonl`
sidecars under `net/measurements/n2/` are **headless software-WebGL (SwiftShader)
smokes** (`net/web-<engine>/smoke/renderProbe.smoke.mjs`): faithful pipeline +
sample SHAPE, but **software** fps/frame-time magnitudes, not the real GPU. This
runner drives the **same** `?probe=1` probe on the **real GPU** by launching a
**headed Chrome** (`headless:false`, SwiftShader NOT forced) and harvesting
`window.__clientRenderSamples` over the Chrome DevTools Protocol — the same
CDP-harvest pattern as `packaging/electron/measure.mjs`, adapted to net's
**2-process topology** (loaded server + vite preview client).

### Two layers — keep them apart

| Layer | How | Magnitudes | Where |
|-------|-----|-----------|-------|
| **software smoke** | headless Chromium, SwiftShader | **NOT real GPU** (software) | `smoke/renderProbe.smoke.mjs`, committed `*-client-render.jsonl` |
| **real-GPU attended** | headed Chrome, real display | real GPU (verified non-SwiftShader) | this runner, `*-client-render.realgpu.jsonl` + `.meta.json` |

### Why this is ATTENDED-only (not CI / not headless)

A trustworthy real-GPU number needs all of:

- a **real display + real GPU** — headless Chromium falls back to SwiftShader
  (software), which is exactly what the smoke already does and is NOT real-GPU;
- a **foreground, visible window** — `requestAnimationFrame` is throttled (or
  paused) when the tab/window is occluded or backgrounded, so an unattended/hidden
  run silently under-measures;
- **vsync awareness** — the window is vsync-capped, so `clientFps` flattens at the
  refresh rate and **frame-time p50/p95 is the primary metric**, fps a ceiling
  indicator (same caveat as `net/bevy/CLAUDE.md` → "vsync caveat");
- **sub-8.3 ms invisibility** — per-frame GPU time below the vsync interval is not
  observable from rAF (non-portable, Spectre-limited); the probe measures
  present-to-present dt, not GPU time;
- **thermal cooldown** — let the machine settle between runs/stages so a hot SoC
  doesn't depress a later stage's numbers.

Because none of these hold in CI/headless, the runner is deliberately **not** wired
into any build/test gate. The CI/local gate for #191 is **build + typecheck +
schema** only (the protocol/clients are unchanged; the smoke still passes).

### Run it (attended, on rio's machine)

```bash
# From repo root. Default ENGINE=three; bots=24, seed=12345, tick=20, n2-stress-ramp.
ENGINE=three   node net/tools/realGpuRender.mjs
ENGINE=babylon node net/tools/realGpuRender.mjs
```

The runner: spawns the loaded server (`net/server` `dev:server:loaded`, reusing the
**exact** `?probe=1...` join-key query the server prints so keys can't drift) →
builds + `vite preview`s the client → launches headed Chrome at the probe URL →
verifies `UNMASKED_RENDERER_WEBGL` is **not** SwiftShader → harvests
`window.__clientRenderSamples` → writes the sidecar + a `.meta.json` → **kills every
spawned process** (server, preview, Chrome) and removes the temp Chrome profile.

> Keep the launched Chrome window **foreground and visible** for the whole run. Do a
> separate run per bot stage (`BOT_COUNT=2`, then `24`, then `100`) with a thermal
> cooldown between, mirroring the server's `n2-stress-ramp` stages so the lines LEFT
> JOIN onto `metrics.jsonl`.

### Output & honesty guard

- **`<out>.jsonl`** — pure `ClientRenderSample` lines (`net/protocol/src/clientRender.ts`),
  identical shape to the smoke output, so it LEFT JOINs and schema-validates the same
  way. Default `net/measurements/n2/web-<engine>-client-render.realgpu.jsonl` (the
  `.realgpu.` suffix avoids clobbering the committed software smoke).
- **`<out>.meta.json`** — the sidecar's **provenance/meta**: `backend:"real-gpu"`,
  `gpuRenderer` (`UNMASKED_RENDERER_WEBGL`), `gpuVendor`, `swiftShaderDetected:false`,
  `userAgent`, the join keys + window knobs. This is the evidence that the run was a
  real GPU — **commit it alongside any real-GPU `.jsonl`** so non-SwiftShader is
  verifiable.
- **Guard:** if the live WebGL renderer matches `swiftshader|llvmpipe|software`, the
  runner **aborts and writes nothing** — a "real-gpu" file is never produced from a
  software context (Core Value #1).

### Knobs

`ENGINE` `BOT_COUNT` `SEED` `TICK` `SCENARIO` `DELAY_UP_MS` `DELAY_DOWN_MS`
`LOSS_UP_PCT` `LOSS_DOWN_PCT` `WARMUP_MS` `WINDOW_MS` `MAX_WINDOWS` `RENDER_OUT`
`SERVER_PORT` `PREVIEW_PORT` `CDP_PORT` `CHROME_BIN` `SKIP_BUILD` `TIMEOUT_MS` — see
the header of `realGpuRender.mjs` for defaults.

### Scope (Won't Do here)

- **Tauri / WKWebView real-GPU automation** — rAF throttles under occlusion and CDP
  can't drive the webview; stays a documented §9 limitation.
- **Bevy native real-GPU sidecar** — separate path; this `.mjs` runner is web-only
  (three/babylon). The native analogue is the shell runner
  `net/bevy/tools/real-gpu-render.sh` (#192): same idea (loaded server + windowed
  `--client` probe, software-adapter guard, sidecar + `.meta.json`, no process leaks),
  but no CDP/browser — the Bevy probe writes its own `ClientRenderSample` lines in-app.
  See `net/bevy/CLAUDE.md` → "Real-GPU run".
- **Unattended / headless real-GPU** — software fallback; that is the smoke's job.
