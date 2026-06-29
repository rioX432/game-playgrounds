# Packaging to a Desktop / Steam Build

This exercises the path COMPARISON.md §6 only *researched*: turning the playgrounds
into desktop, Steam-ready builds. **Three routes** — two desktop shells for the web
engines (Electron, Tauri) and the native Bevy binary.

> **Status:** the path is now **exercised on macOS (Apple Silicon)** — an Electron
> `.dmg`/`.app` (Route A, Three.js), a **Tauri `.app`** (Route C, Three.js), and the
> native Bevy binary (Route B) have all been built; the packaged Electron app was
> verified to launch and render the gallery, and Tauri's WKWebView shell was confirmed
> WebGPU-GO on macOS 26. The Electron-vs-Tauri distribution trade-off (237 MB vs 5 MB,
> WebGPU availability, measurement) is the subject of **chapter 3 / COMPARISON.md §9**.
> What remains **[maintainer]** is code signing / notarization, the Windows `.exe`
> cross-build, and the Steamworks upload (all need credentials a machine can't supply —
> see the verified results below).

---

## Route A — Web engines (three / babylon) via Electron

The web builds run in a desktop window via an Electron shell, then
`electron-builder` packages that to an installer/app. The shell lives in
`packaging/electron/` and is **standalone** — it does not touch the engine
projects' dependencies.

### 1. Build the web app with relative asset paths

Electron loads the build over `file://`, so Vite must emit **relative** asset
URLs. Build with a relative base:

```bash
cd three            # or: cd babylon
# Vite honors --base; or set base: './' in vite.config.ts for the Electron build.
npm run build -- --base=./
```

This produces `three/dist/` (or `babylon/dist/`).

### 2. Run / package the Electron shell

```bash
cd packaging/electron
npm install                       # pulls electron + electron-builder
WEB_DIST=../../three/dist npm start   # smoke-test in a desktop window
# Unsigned local build (no Apple Developer cert needed):
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist
# Signed/notarized build for distribution:        [maintainer]
npm run dist                      # auto-discovers a signing identity
```

`WEB_DIST` selects which engine's `dist/` to load at dev time (defaults to
`three/dist`). The **packaged** app instead loads the `web` dir bundled via
electron-builder `extraResources` (resolved from `process.resourcesPath` — see
`main.cjs`; a plain `../../three/dist` does **not** exist inside the .app). The
packaged target per OS is configured in `packaging/electron/package.json`
(`win: nsis`, `mac: dmg`, `linux: AppImage`).

> **Signing gotcha:** a bare `npm run dist` makes electron-builder auto-discover a
> local signing identity. If that cert is expired/revoked the build fails at
> `codesign --verify` (`CSSMERR_TP_CERT_REVOKED`). Use
> `CSC_IDENTITY_AUTO_DISCOVERY=false` for an unsigned local artifact; real signing
> is a **[maintainer]** step (needs a valid Apple Developer cert + notarization).

> **Electron vs Tauri (now measured, chapter 3 / COMPARISON §9):** Electron bundles
> its own Chromium → WebGPU on **any** macOS and behaves like a normal measurable app,
> at **237 MB** installed. Tauri uses the **system** WebView → a **5.0 MB** app, but
> WebGPU is **macOS-26+ only** and the webview throttles when not frontmost. Electron is
> the safe, heavy default; Tauri the featherweight gamble. See Route C below.

### Verified build (2026-06, macOS arm64, this repo)

| Route | Command | Output | Result |
|---|---|---|---|
| A (Three via Electron) | `npm run build -- --base=./` then `CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist` | `packaging/electron/dist/Game Playgrounds-0.1.0-arm64.dmg` (≈95 MB installer; **237 MB installed `.app`**) + `dist/mac-arm64/Game Playgrounds.app` | **Built (unsigned).** Launching the `.app` renders the full gallery (sample list + a running sample), confirming the packaged content path resolves. |
| B (Bevy native) | `cargo build --release` | `bevy/target/release/bevy-playground` (≈95 MB) | **Built & runs.** Native binary, no wrapper. |
| C (Three via Tauri) | `npm run build -- --base=./` then `cargo tauri build` | `packaging/tauri` `.app` (**5.0 MB**, ~47× smaller than Electron) | **Built (`.app`).** System WKWebView; **WebGPU GO on macOS 26**. `.dmg` bundling failed locally on unsigned `hdiutil`; frame-time not headless-capturable (WKWebView throttles when occluded) — see Route C + COMPARISON §9. |

Artifacts are **not committed** (binaries, `.gitignore`d); the table records that
the path was exercised. The Windows `nsis` `.exe` target is **not** produced here
(electron-builder can't reliably cross-build a signed Windows installer from
macOS without Wine/a Windows host) — **[maintainer]**.

---

## Route B — Bevy (native, no wrapper)

Bevy is already a native binary; no shell needed:

```bash
cd bevy
cargo build --release             # produces target/release/bevy-playground
```

Ship the release binary (plus any assets) directly. This is the shortest path —
no Electron, no web runtime.

---

## Route C — Web engines (three / babylon) via Tauri

The lightweight counterpart to Route A: the same web build, wrapped in a **system
WKWebView** by a standalone Tauri v2 shell (`packaging/tauri/`, **does not** touch the
engine projects). ~47× smaller than Electron because it bundles no browser — at the cost
of an OS-bound WebView. Built as part of chapter 3 (web-on-steam); full trade-off in
COMPARISON §9.

```bash
# 1. Build the web app with a relative base (so the asset protocol resolves):
cd three
npm run build -- --base=./

# 2. Build / bundle the Tauri shell (RELEASE required for the WebGPU path):
cd packaging/tauri
cargo check                       # fast verify
cargo build --release             # plain build (no bundle)
cargo tauri build                 # bundle a .app/.dmg (needs `cargo install tauri-cli`)
```

> Unlike the Electron shell (which selects a `dist/` at dev time via `WEB_DIST`), the
> Tauri shell's `frontendDist` is fixed to `three/dist` at **compile** time — point it
> at `babylon/dist` by editing `packaging/tauri/tauri.conf.json` before building.

> **WebGPU is release-build + macOS-26-gated.** WKWebView ships WebGPU only on
> **macOS 26+** (it's bound to the OS, unlike Electron's bundled Chromium), and
> [tauri#6381](https://github.com/tauri-apps/tauri/issues/6381) reports WebGPU init
> failing in Tauri **dev** builds — so measure in a **release** build. On older macOS a
> Tauri+WebGPU build reaches no one; use Electron (Route A) if you need WebGPU below
> macOS 26.

> **Measurement gotcha:** WKWebView throttles `requestAnimationFrame`/timers whenever its
> window is not frontmost, and it has no Chromium CDP, so frame-time can't be harvested
> headlessly the way Electron's window can — it needs an attended, truly-foregrounded run.
> The IPC harness (`packaging/tauri/src/main.rs`, `window.__renderSamples` → Tauri
> `invoke`) is in place for it. Details: `packaging/tauri/README.md`.

---

## Steam upload  **[maintainer — requires credentials]**

An agent cannot complete this; it needs the maintainer's Steamworks account and
secrets. Checklist:

1. Steamworks **developer account** + the one-time **$100** app fee (recouped
   after $1,000 earned).
2. Create the **app** in Steamworks; note the **App ID** (+ depot IDs).
3. Set up a **store page** (description, capsule art, screenshots) and the build
   depots.
4. Code-sign the binary (Windows: an EV/OV cert; macOS: an Apple Developer cert
   + notarization) so it isn't flagged on launch.
5. Upload the build with `steamcmd` (or the Steamworks SDK `ContentBuilder`)
   using your partner login, point the depot at the packaged output from Route
   A/B, and publish to a branch.
6. You keep **70%** of revenue.

Nothing here is exercised in this repo — it is the documented next step for the
maintainer once a packaged artifact (Route A or B) is produced.
