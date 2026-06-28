import { defineConfig } from "vitest/config";

// Pure logic tests only (client-render sampler). No DOM, no GPU — the render path
// is verified by manual/Playwright smoke in the per-engine probes (#166/#167/#168).
export default defineConfig({
  test: {
    environment: "node",
  },
});
