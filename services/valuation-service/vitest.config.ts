import { defineConfig } from "vitest/config";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 10_000,
    hookTimeout: 60_000,
    fileParallelism: false
  },
});
