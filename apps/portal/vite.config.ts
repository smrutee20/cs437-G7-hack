import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { localDevServer } from "../../packages/config/src/local-dev.js";

export default defineConfig(({ command }) => ({
  plugins: [react()],
  // Local HTTPS dev server only. Production HTTPS/origin policy belongs to deployment.
  server: command === "serve" ? localDevServer("portal", resolve(import.meta.dirname, "../..")) : undefined,
}));
