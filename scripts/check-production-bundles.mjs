// Build gate (SPEC.md §16, scenario 4): the production bundles must not contain the
// synthetic demo login or any inline script/style. The separate demo build is exempt.
import { resolve } from "node:path";
import { loadBundle } from "../packages/http/dist/index.js";

const root = resolve(import.meta.dirname, "..");
for (const app of ["portal", "respond"]) {
  try {
    const bundle = await loadBundle(resolve(root, "apps", app, "dist"), { production: true });
    console.log(`production bundle ok: ${app} (${bundle.assets.size} assets)`);
  } catch (error) {
    console.error(`${app}: ${error instanceof Error ? error.message : "bundle check failed"}`);
    process.exitCode = 1;
  }
}
