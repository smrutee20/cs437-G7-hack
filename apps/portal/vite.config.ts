import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { localDevServer, originDefines } from "../../packages/config/src/local-dev.js";

export default defineConfig(({ command }) => ({
  plugins: [react()],
  define: originDefines(),
  // Use workspace package sources directly (see packages/protocol "source" export).
  resolve: { conditions: ["source", "module", "browser", "development|production"] },
  // Local HTTPS dev server only. Production HTTPS/origin policy belongs to deployment.
  server: command === "serve" ? {
    ...localDevServer("portal", resolve(import.meta.dirname, "../..")),
    proxy: process.env.FEEDBACK_DEMO_API === "1" ? {
      "/api": "http://127.0.0.1:5183",
      "/__demo": "http://127.0.0.1:5185",
    } : undefined,
  } : undefined,
}));
