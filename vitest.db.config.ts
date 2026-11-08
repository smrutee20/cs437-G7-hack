import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Resolve the workspace protocol package from source, so tests never run
// against a stale dist/ build. Only this exact specifier is aliased.
const protocolSource = fileURLToPath(new URL("./packages/protocol/src/index.ts", import.meta.url));
const httpSource = fileURLToPath(new URL("./packages/http/src/index.ts", import.meta.url));
const productionSource = fileURLToPath(new URL("./packages/config/src/production.ts", import.meta.url));

export default defineConfig({
  resolve: { alias: [
    { find: /^@iitgn-feedback\/protocol$/, replacement: protocolSource },
    { find: /^@iitgn-feedback\/http$/, replacement: httpSource },
    { find: /^@iitgn-feedback\/config\/production$/, replacement: productionSource },
  ] },
  test: {
    include: ["tests/db/**/*.test.ts"],
    globalSetup: ["tests/db/global-setup.ts"],
    // One real PostgreSQL instance; test files run serially against it.
    fileParallelism: false,
    maxWorkers: 1,
  },
});
