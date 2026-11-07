import { defineConfig } from "rolldown";

export default defineConfig({
  input: "src/worker.ts",
  platform: "neutral",
  resolve: { conditionNames: ["source", "import", "default"], mainFields: ["module", "main"] },
  // workerd loads only the embedded bundle, so any unresolved import is a build failure.
  onLog(level, log, handler) {
    if (log.code === "UNRESOLVED_IMPORT") throw new Error(log.message);
    handler(level, log);
  },
  output: { file: "dist/worker.js", format: "esm", sourcemap: false },
});
