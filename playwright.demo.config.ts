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
const reuse=!process.env.CI;
export default defineConfig({
  testDir:"tests/demo-browser",fullyParallel:false,retries:0,timeout:45_000,
  use:{ignoreHTTPSErrors:true,trace:"off",screenshot:"off",video:"off"},
  projects:[
    {name:"demo-chromium",use:{...devices["Desktop Chrome"],launchOptions:{args:["--no-proxy-server",`--host-resolver-rules=${hosts.map((host)=>`MAP ${host} 127.0.0.1`).join(",")}`]}}},
    {name:"demo-firefox",use:{...devices["Desktop Firefox"],launchOptions:{firefoxUserPrefs:{"network.dns.localDomains":hosts.join(","),"network.proxy.type":0}}}},
  ],
  webServer:[
    {command:"FEEDBACK_ENABLE_SYNTHETIC_DEMO=yes-synthetic-only node services/portal-api/dev/demo.mjs",
      url:"http://127.0.0.1:5183/api/v1/session",reuseExistingServer:reuse,timeout:30_000},
    {command:"FEEDBACK_DEMO_API=1 npm run dev -w @iitgn-feedback/portal",
      url:"https://127.0.0.1:4173",ignoreHTTPSErrors:true,reuseExistingServer:reuse,timeout:30_000},
    {command:"FEEDBACK_DEMO_API=1 npm run dev -w @iitgn-feedback/respond",
      url:"https://127.0.0.1:4174",ignoreHTTPSErrors:true,reuseExistingServer:reuse,timeout:30_000},
  ],
});
