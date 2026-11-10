import { readFileSync } from "node:fs";
import { request } from "node:https";
import { expect, test } from "@playwright/test";
import { localOrigins, localTlsPaths, originPort } from "../../packages/config/src/local-dev.js";

const origins = localOrigins();
const ca = readFileSync(localTlsPaths(process.cwd()).ca);

/** HTTPS GET to `hostname` at loopback, verifying the chain against the local CA and the name. */
function strictGet(hostname: string, port: number): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        servername: hostname,
        port,
        path: "/",
        headers: { host: `${hostname}:${port}` },
        ca,
        rejectUnauthorized: true,
        agent: false,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolvePromise({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("each hostname serves its own app over HTTPS trusted by the local CA", async () => {
  const portal = await strictGet(origins.portal.hostname, originPort(origins.portal));
  const respond = await strictGet(origins.respond.hostname, originPort(origins.respond));
  expect(portal.status).toBe(200);
  expect(respond.status).toBe(200);
  expect(portal.body).toContain("<title>IITGN Freed Back · Portal</title>");
  expect(respond.body).toContain("<title>IITGN Freed Back · Respond</title>");
  expect(portal.body).not.toEqual(respond.body);
});

test("a hostname outside the certificate is rejected, so the check is not vacuous", async () => {
  await expect(strictGet("unlisted.feedback.test", originPort(origins.portal))).rejects.toThrow(/altnames|Hostname/i);
});
