import { defineConfig, devices } from "@playwright/test";
import { localOrigins, localTlsPaths } from "./packages/config/src/local-dev.js";

// Fail at config load, before any server or browser starts, if the two origins
// are not isolated (e.g. same host on different ports) or TLS material is missing.
const origins = localOrigins();
localTlsPaths(import.meta.dirname);
const hosts = [origins.portal.hostname, origins.respond.hostname];

export default defineConfig({
  testDir: "tests/browser",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 30_000,
  use: {
    // Browsers do not trust the local CA, so certificate errors are ignored
    // in the browser only. The "tls" setup project verifies each hostname's
    // certificate chain and name against .certs/dev-ca.crt without bypasses.
    ignoreHTTPSErrors: true,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [
    { name: "tls", testMatch: /.*\.setup\.ts/ },
    {
      name: "chromium",
      dependencies: ["tls"],
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: ["--no-proxy-server", `--host-resolver-rules=${hosts.map((host) => `MAP ${host} 127.0.0.1`).join(",")}`],
        },
      },
    },
    {
      name: "firefox",
      dependencies: ["tls"],
      use: {
        ...devices["Desktop Firefox"],
        launchOptions: {
          firefoxUserPrefs: {
            "network.dns.localDomains": hosts.join(","),
            "network.proxy.type": 0,
          },
        },
      },
    },
  ],
  webServer: (["portal", "respond"] as const).map((app) => ({
    command: `npm run dev -w @iitgn-feedback/${app}`,
    url: `https://127.0.0.1:${origins[app].port}`,
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 30_000,
  })),
});
