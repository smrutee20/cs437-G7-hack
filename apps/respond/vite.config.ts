import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { localDevServer, originDefines } from "../../packages/config/src/local-dev.js";

export default defineConfig(({ command }) => ({
  plugins: [react()],
  define: originDefines(),
  // Use workspace package sources directly (see packages/protocol "source" export).
  resolve: { conditions: ["source", "module", "browser", "development|production"] },
  // Pre-bundle up front so first use doesn't trigger a dependency-discovery reload.
  optimizeDeps: { include: ["@cloudflare/blindrsa-ts"] },
  // Local HTTPS dev server only. Production HTTPS/origin policy belongs to deployment.
  server: command === "serve" ? localDevServer("respond", resolve(import.meta.dirname, "../..")) : undefined,
}));
