import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // A package that depends on another reads its source here, so a test run needs no build first.
  resolve: {
    alias: {
      "@cordwood/firebase": path.resolve(import.meta.dirname, "packages/firebase/src/index.ts"),
      "@cordwood/tour/react": path.resolve(import.meta.dirname, "packages/tour/src/react.ts"),
      // The registry's components import the app's own primitives by this alias.
      "@": path.resolve(import.meta.dirname, "registry"),
    },
  },
  test: {
    environment: "node",
    include: ["packages/*/src/**/*.test.ts", "registry/cordwood/**/*.test.tsx"],
    // The emulator suites create accounts and wait on Auth: slower than a unit test, never this slow.
    testTimeout: 30_000,
  },
});
