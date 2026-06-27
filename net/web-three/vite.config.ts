import { defineConfig } from "vite";

// Standalone Vite app for the N1 Three.js networking client. It imports the
// shared `net-protocol` package (TypeScript source authored with `.js` import
// specifiers) — Vite's resolver maps those to their `.ts` sources in both dev
// and build, so no extra resolve config is needed.
export default defineConfig({
  server: {
    port: 5174,
  },
});
