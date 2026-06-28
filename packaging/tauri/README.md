# Tauri desktop shell + measurement harness (Steam packaging, web-on-steam #175)

A **standalone** Tauri v2 shell that wraps a built web playground (`three/dist`) in a
WKWebView window — the "web → Tauri → Steam" distribution path, the lightweight
counterpart to the Electron shell (`../electron`). It also embeds a measurement harness
for the web-on-steam Layer-2 (host-overhead) runs.

```bash
# Build the web app with a relative base first (so the asset protocol resolves):
cd ../../three && npm run build -- --base=./

# Build + run (release REQUIRED for the WebGPU path — see the WebGPU note below):
cd ../../packaging/tauri
cargo build --release            # plain build (no bundle); `cargo check` for a fast verify
cargo tauri build                # bundle a .app + .dmg (needs `cargo install tauri-cli`)
```

- `src/main.rs` — the Tauri app. With no args it opens the gallery. The measurement harness
  is driven by `--query`/`--report`/`--debug`/`--max-windows`/`--timeout` **argv** (so it
  survives `open --args`, which does not forward env vars; env vars of the same name are a
  fallback). An `initialization_script` polls the in-page `window.__renderSamples` and hands
  the JSON back to Rust over Tauri IPC (`report`), which writes `--report` and exits — WKWebView
  has no Chromium CDP, so external harvesting (like the Electron runner) isn't possible.
- `tauri.conf.json` — `frontendDist` is fixed at COMPILE time (three/dist); `withGlobalTauri`
  exposes `window.__TAURI__.core.invoke` to the init script; `capabilities/default.json` grants
  the window `core:default` so IPC works.

## Findings (Apple M3 Pro / macOS 26.6) — see `net/measurements/web-on-steam/README.md`

- **Size: `.app` = 5.0 MB** (vs the Electron shell's 237 MB — ~47× smaller). Tauri uses the
  **system** WKWebView, bundling no browser. (`cargo tauri build` produced the `.app`; the
  `.dmg` step failed locally on an unsigned `bundle_dmg.sh`/`hdiutil` run — the `.app`
  footprint is the honest headline.)
- **WebGPU = GO**: `navigator.gpu === true` measured inside the real Tauri **release** WKWebView
  on macOS 26 (confirms the raw-WKWebView spike in `docs/web-on-steam/PR0-webgpu-availability.md`).
  Caveats carry over: macOS-26+ only (WKWebView is OS-bound), and tauri#6381 reports WebGPU init
  failing in Tauri **dev** builds — measure in a release build.
- **RAM is NOT process-tree-comparable to Electron.** The Tauri app process is ~104 MB RSS, but
  the web content runs in **shared macOS `com.apple.WebKit.{WebContent,GPU,Networking}` XPC
  services** that are launchd-owned (not app children, shared across all WKWebViews) — so the
  Electron "sum the process tree" method has no honest Tauri equivalent.
- **Frame-time could not be captured headlessly.** WKWebView throttles `requestAnimationFrame`
  and timers whenever its window is not frontmost/visible; in this automated session the window
  stayed `document.visibilityState === "hidden"` (despite `visible`/`focused`/`always_on_top`/
  `set_focus` and launching the bundled `.app` via `open`), so the probe never accumulated a
  measurement window. Electron's Chromium window foregrounds and measures reliably in the
  identical harness. This is an honest §9 gap, not a fixable bug — frame-time parity for Tauri
  is **not established** here; the IPC harness is in place for an attended (truly-foregrounded)
  re-run.
