# Electron desktop shell (Steam packaging)

A **standalone** Electron shell that wraps a built web playground (`three/` or
`babylon/` `dist/`) in a desktop window, so it can be packaged to a Steam-ready
installer. It is intentionally separate from the engine projects so it never
affects their `npm install` / build.

Full walkthrough: [`../../docs/PACKAGING.md`](../../docs/PACKAGING.md).

```bash
# from this directory:
npm install                            # pulls electron + electron-builder
WEB_DIST=../../three/dist npm start    # smoke-test (build the web app first, base './')
npm run dist                           # package to .exe / .dmg / AppImage
```

- `main.cjs` — the Electron main process; loads `WEB_DIST/index.html` (defaults
  to `three/dist`).
- The web build MUST be produced with a relative base (`npm run build -- --base=./`)
  so `file://` resolves Vite's asset URLs.

Not installed/built in CI — see the **Status** note in `docs/PACKAGING.md`.
