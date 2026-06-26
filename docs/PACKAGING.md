# Packaging to a Desktop / Steam Build

This exercises the path COMPARISON.md §6 only *researched*: turning the playgrounds
into desktop, Steam-ready builds. Two routes, by engine.

> **Status:** the path is now **exercised on macOS (Apple Silicon)** — both an
> Electron `.dmg`/`.app` (Route A, Three.js) and the native Bevy binary (Route B)
> have been built and the packaged Electron app was verified to launch and render
> the gallery. What remains **[maintainer]** is code signing / notarization, the
> Windows `.exe` cross-build, and the Steamworks upload (all need credentials a
> machine can't supply — see the verified results below).

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

> **Electron over Tauri for games:** more consistent rendering across machines
> (bundled Chromium) — see COMPARISON §6.

### Verified build (2026-06, macOS arm64, this repo)

| Route | Command | Output | Result |
|---|---|---|---|
| A (Three via Electron) | `npm run build -- --base=./` then `CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist` | `packaging/electron/dist/Game Playgrounds-0.1.0-arm64.dmg` (≈95 MB) + `dist/mac-arm64/Game Playgrounds.app` | **Built (unsigned).** Launching the `.app` renders the full gallery (sample list + a running sample), confirming the packaged content path resolves. |
| B (Bevy native) | `cargo build --release` | `bevy/target/release/bevy-playground` (≈95 MB) | **Built & runs.** Native binary, no wrapper. |

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
