import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Resolve the workspace protocol package from source, so tests never run
// against a stale dist/ build. Only this exact specifier is aliased.
const protocolSource = fileURLToPath(new URL("./packages/protocol/src/index.ts", import.meta.url));

export default defineConfig({
  resolve: { alias: [{ find: /^@iitgn-feedback\/protocol$/, replacement: protocolSource }] },
  test: {
    include: ["tests/unit/**/*.test.ts"],
  },
});
