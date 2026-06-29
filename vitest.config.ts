import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["sidecar/tests/**/*.test.ts", "control/tests/**/*.test.ts"],
    testTimeout: 20000,
  },
});
