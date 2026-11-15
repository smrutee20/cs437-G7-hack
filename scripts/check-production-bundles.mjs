// Build gate (SPEC.md §16, scenario 4): the production bundles must not contain the
// synthetic demo login or any inline script/style. The separate demo build is exempt.
import { resolve } from "node:path";
import { loadBundle } from "../packages/http/dist/index.js";

const root = resolve(import.meta.dirname, "..");
for (const app of ["portal", "respond"]) {
  try {
    const bundle = await loadBundle(resolve(root, "apps", app, "dist"), { production: true });
    if (process.env.FEEDBACK_BUILD_TARGET === "deployment") {
      const peer = app === "portal" ? "FEEDBACK_RESPOND_ORIGIN" : "FEEDBACK_PORTAL_ORIGIN";
      const scripts = [...bundle.assets.values()].filter((asset) => asset.type.startsWith("text/javascript"));
      if (!process.env[peer] || !scripts.some((asset) => asset.body.includes(process.env[peer])) ||
          scripts.some((asset) => /https:\/\/[^"'\s]+\.(?:test|localhost|local|example|invalid|internal)(?=[:/"'\s]|$)/.test(asset.body.toString("utf8")))) {
        throw new Error(`SETUP ERROR: ${app} browser bundle has a missing or development peer origin`);
      }
    }
    console.log(`production bundle ok: ${app} (${bundle.assets.size} assets)`);
  } catch (error) {
    console.error(`${app}: ${error instanceof Error ? error.message : "bundle check failed"}`);
    process.exitCode = 1;
  }
}
