import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    include: ["**/*.convex.test.ts"],
    testTimeout: 15_000,
  },
});
