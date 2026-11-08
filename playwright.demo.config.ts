// Optional synthetic-only browser suite. Requires local disposable Postgres 17
// and .certs/; never connects to production credentials or accounts.
import { defineConfig, devices } from "@playwright/test";
import { localOrigins, localTlsPaths } from "./packages/config/src/local-dev.js";

const origins=localOrigins();
if(origins.portal.origin!=="https://portal.feedback.test:4173" ||
   origins.respond.origin!=="https://respond.feedback.test:4174") {
  throw new Error("SETUP ERROR: synthetic browser tests require the fixed local .test origins");
}
localTlsPaths(import.meta.dirname);
const hosts=[origins.portal.hostname,origins.respond.hostname];
export default defineConfig({
  testDir:"tests/demo-browser",fullyParallel:false,retries:0,timeout:45_000,
  use:{ignoreHTTPSErrors:true,trace:"off",screenshot:"off",video:"off"},
  projects:[
    {name:"demo-chromium",use:{...devices["Desktop Chrome"],launchOptions:{args:["--no-proxy-server",`--host-resolver-rules=${hosts.map((host)=>`MAP ${host} 127.0.0.1`).join(",")}`]}}},
    {name:"demo-firefox",use:{...devices["Desktop Firefox"],launchOptions:{firefoxUserPrefs:{"network.dns.localDomains":hosts.join(","),"network.proxy.type":0}}}},
  ],
  // Production-like topology: the launcher serves the built bundles itself on both HTTPS
  // origins with the production header set (strict CSP), on a fresh disposable database.
  webServer:[
    {command:"FEEDBACK_ENABLE_SYNTHETIC_DEMO=yes-synthetic-only FEEDBACK_DEMO_SERVE=built FEEDBACK_DEMO_EPHEMERAL=1 node services/portal-api/dev/demo.mjs",
      url:"https://127.0.0.1:4173",ignoreHTTPSErrors:true,reuseExistingServer:false,timeout:60_000},
  ],
});
