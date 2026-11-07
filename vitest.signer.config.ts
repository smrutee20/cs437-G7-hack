import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/signer/**/*.test.ts"],
    globalSetup: ["tests/signer/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
