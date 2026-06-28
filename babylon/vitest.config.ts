import { defineConfig } from "vitest/config";

// Pure headless logic tests only (percentile, window aggregation, RNG determinism).
// No DOM, no GPU, no physics — the WebGL/auto-measure path is a separate manual run
// (see src/measure/globals.ts for the SwiftShader caveat).
export default defineConfig({
  test: {
    environment: "node",
  },
});
