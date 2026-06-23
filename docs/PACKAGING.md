# Packaging to a Desktop / Steam Build

This exercises the path COMPARISON.md §6 only *researched*: turning the playgrounds
into desktop, Steam-ready builds. Two routes, by engine.

> **Status:** the scaffold + steps below are committed and ready to run. The
> actual packaged artifacts are **not** built here — `electron-builder` needs a
> network `npm install` plus platform-specific toolchains (and produces a
> per-OS binary), and the Steamworks upload needs the maintainer's account +
> credentials. Those steps are marked **[maintainer]**.

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
npm install                       # [maintainer] pulls electron + electron-builder
WEB_DIST=../../three/dist npm start   # smoke-test in a desktop window
npm run dist                      # [maintainer] build the installer (.exe / .dmg / AppImage)
```

`WEB_DIST` selects which engine's `dist/` to load (defaults to `three/dist`).
The packaged target per OS is configured in `packaging/electron/package.json`
(`win: nsis`, `mac: dmg`, `linux: AppImage`).

> **Electron over Tauri for games:** more consistent rendering across machines
> (bundled Chromium) — see COMPARISON §6.

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
