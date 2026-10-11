import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // A package that depends on another reads its source here, so a test run needs no build first.
  resolve: {
    alias: {
      "@cordwood/firebase": path.resolve(import.meta.dirname, "packages/firebase/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["packages/*/src/**/*.test.ts"],
    // The emulator suites create accounts and wait on Auth: slower than a unit test, never this slow.
    testTimeout: 30_000,
  },
});
