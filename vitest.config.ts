import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // The interop suite spawns its own anvil and HTTP servers on ephemeral ports; keep files
    // isolated but run them in parallel workers.
    fileParallelism: true,
    reporters: process.env.CI ? ["default", "junit"] : ["default"],
    outputFile: { junit: "test-results/junit.xml" },
  },
});
