import { defineConfig } from "vite";

// Three.js + Rapier (-compat) bundle fine with esbuild; no special config needed.
export default defineConfig({
  server: {
    port: 5173,
  },
});
