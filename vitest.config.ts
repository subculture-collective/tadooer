import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./apps/web/src"),
    },
  },
  test: {
    // Server integration tests start a real HTTP server and SQLite database
    // per case and take 1-2 s on an idle host. CI shares its runner host with
    // other workloads, where the 5 s default fails healthy cases.
    testTimeout: 20_000,
  },
});
