import { defineConfig } from "vite";

// Standalone Vite app for the N1 Babylon.js networking client. It imports the
// shared `net-protocol` package (TypeScript source authored with `.js` import
// specifiers) — Vite's resolver maps those to their `.ts` sources in both dev
// and build, so no extra resolve config is needed. Sibling of `net/web-three`:
// same netcode, different render engine, so it gets its own dev port.
export default defineConfig({
  server: {
    port: 5175,
  },
});
