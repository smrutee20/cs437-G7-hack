import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/db/**/*.test.ts"],
    globalSetup: ["tests/db/global-setup.ts"],
    // One real PostgreSQL instance; test files run serially against it.
    fileParallelism: false,
    maxWorkers: 1,
  },
});
