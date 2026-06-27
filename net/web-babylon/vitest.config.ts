import { defineConfig } from "vitest/config";

// Pure logic tests only (snapshot interpolation buffer + input derivation). No
// DOM, no Colyseus, no GPU — the browser path is verified by manual/Playwright
// smoke (see README). Mirrors net/web-three's test setup.
export default defineConfig({
  test: {
    environment: "node",
  },
});
