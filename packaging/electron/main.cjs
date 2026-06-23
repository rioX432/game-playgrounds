// Minimal Electron main process: wraps a built web playground (three/ or
// babylon/ `dist/`) in a desktop window so it can be packaged to a Steam-ready
// .exe / .app. This is the "web → Electron → Steam" path from COMPARISON.md §6.
//
// Which build to load is chosen by the WEB_DIST env var (defaults to the Three.js
// build), pointing at the engine's `dist/` produced by `npm run build`.
//
// IMPORTANT: for file:// loading to resolve Vite's asset URLs, the web build must
// be produced with `base: './'` (relative). See docs/PACKAGING.md.

const { app, BrowserWindow } = require("electron");
const path = require("node:path");

// Resolve the web build's dist dir. Relative to the repo root by default.
const repoRoot = path.resolve(__dirname, "..", "..");
const webDist = process.env.WEB_DIST
  ? path.resolve(process.env.WEB_DIST)
  : path.join(repoRoot, "three", "dist");

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    backgroundColor: "#0c0f14",
    webPreferences: {
      // The playground is trusted local content; no Node integration needed.
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(webDist, "index.html"));
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // On macOS apps usually stay active until Cmd+Q; elsewhere quit on close.
  if (process.platform !== "darwin") app.quit();
});
