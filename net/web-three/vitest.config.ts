import { defineConfig } from "vitest/config";

// Pure logic tests only (snapshot interpolation buffer). No DOM, no Colyseus,
// no GPU — the browser path is verified by manual/Playwright smoke (see README).
export default defineConfig({
  test: {
    environment: "node",
  },
});
