import { defineConfig } from "vite";

// Babylon's Havok physics ships a WASM binary. Vite must not try to
// pre-bundle/transform it; excluding it from optimizeDeps keeps the
// `.wasm` asset served as-is so HavokPhysics() can fetch it at runtime.
export default defineConfig({
  server: {
    port: 5173,
  },
  optimizeDeps: {
    exclude: ["@babylonjs/havok"],
  },
  build: {
    target: "es2022",
  },
});
