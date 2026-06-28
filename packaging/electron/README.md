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
  to `three/dist`). Honours `MEASURE_QUERY` (a `?sample=...&measure=1&...` search
  string) for the web-on-steam Layer-2 host-overhead runs.
- `measure.mjs` — host-overhead measurement runner (web-on-steam #174): launches this
  shell across a body-count ramp over CDP, harvests `window.__renderSamples`, and records
  process-tree RAM + cold-start. Procedure + results:
  [`../../net/measurements/web-on-steam/README.md`](../../net/measurements/web-on-steam/README.md).
- The web build MUST be produced with a relative base (`npm run build -- --base=./`)
  so `file://` resolves Vite's asset URLs.

Not installed/built in CI — see the **Status** note in `docs/PACKAGING.md`.
