// Production entrypoints (SPEC.md §12, §14, §16) on real HTTPS listeners and
// real per-role PostgreSQL logins: browser headers, request bounds, ingress
// hygiene, and every fail-closed startup check. A minimal loopback signer
// stand-in answers only /health; native signing is covered in tests/signer.
import { randomBytes } from "node:crypto";
import { copyFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import type { PortalConfig, RespondConfig } from "../../packages/config/src/production";
import { CONTENT_SECURITY_POLICY } from "../../packages/http/src/headers";
import { appendJournalEntry, readJournal } from "../../services/portal-api/src/journal";
import { migrateFoundation, rollbackFoundation } from "../../services/portal-api/src/migrate";
import { startPortalServer } from "../../services/portal-api/src/server";
import { startRespondServer } from "../../services/respond-api/src/server";

const url = inject("testDatabaseUrl"), repo = resolve(import.meta.dirname, "../..");
const suffix = randomBytes(4).toString("hex");
const groups = { portal: "feedback_portal_admin", issuer: "feedback_issuer", auth: "feedback_auth", closer: "feedback_closer",
  retention: "feedback_retention", respond: "feedback_response_public" } as const;
const logins = Object.fromEntries(Object.keys(groups).map((name) => [name, { user: `feedback_t_${name}_${suffix}`, password: randomBytes(16).toString("hex") }])) as
  Record<keyof typeof groups, { user: string; password: string }>;
const loginUrl = (name: keyof typeof groups) => {
  const target = new URL(url); target.username = logins[name].user; target.password = logins[name].password; return target.href;
};
let dir: string, signer: Server, signerUrl: string, ca: Buffer;
const token = randomBytes(32).toString("base64url");
let healthy = true;

beforeAll(async () => {
  await migrateFoundation(url);
  const admin = new Client({ connectionString: url });
  await admin.connect();
  try {
    for (const [name, group] of Object.entries(groups)) {
      const { user, password } = logins[name as keyof typeof groups];
      await admin.query(`CREATE ROLE ${user} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
      await admin.query(`GRANT ${group} TO ${user}`);
    }
  } finally { await admin.end(); }
  dir = await mkdtemp(join(tmpdir(), "feedback-prod-"));
  await mkdir(join(dir, "keys"), { mode: 0o700 });
  for (const [from, to] of [[".certs/dev-server.crt", "tls.crt"], [".certs/dev-server.key", "tls.key"]]) {
    await copyFile(join(repo, from), join(dir, to)); await chmod(join(dir, to), 0o600);
  }
  ca = await readFile(join(repo, ".certs/dev-ca.crt"));
  for (const [file, bytes] of [["client-secret", "test-client-secret"], ["kek", randomBytes(32)], ["cursor", randomBytes(32).toString("base64url")], ["signer-token", token]] as const) {
    await writeFile(join(dir, file), bytes, { mode: 0o600 });
  }
  await writeFile(join(dir, "journal.jsonl"), "", { mode: 0o600 });
  for (const app of ["portal", "respond"]) {
    await mkdir(join(dir, app, "assets"), { recursive: true });
    await writeFile(join(dir, app, "index.html"), `<!doctype html><title>${app}</title><script type="module" src="/assets/app-1a2b.js"></script>`);
    await writeFile(join(dir, app, "assets", "app-1a2b.js"), `console.log("${app}")`);
  }
  signer = createServer((req, res) => {
    const ok = healthy && req.url === "/health" && req.headers.authorization === `Bearer ${token}`;
    res.writeHead(ok ? 200 : 503, { "content-type": "application/json" }).end(ok ? '{"status":"ready"}' : '{"error":"unavailable"}');
  });
  await new Promise<void>((done) => signer.listen(0, "127.0.0.1", done));
  signerUrl = `http://127.0.0.1:${(signer.address() as { port: number }).port}`;
});
afterAll(async () => {
  if (signer) await new Promise((done) => signer.close(done));
  await rollbackFoundation(url);
  const admin = new Client({ connectionString: url });
  await admin.connect();
  try { for (const { user } of Object.values(logins)) await admin.query(`DROP ROLE IF EXISTS ${user}`); } finally { await admin.end(); }
  if (dir) await rm(dir, { recursive: true, force: true });
});

const origins = { portal: new URL("https://portal.feedback.test:4473"), respond: new URL("https://respond.feedback.test:4474") };
const portalConfig = (overrides: Partial<PortalConfig> = {}): PortalConfig => ({
  service: "portal", origins, tls: { certFile: join(dir, "tls.crt"), keyFile: join(dir, "tls.key") },
  listen: { host: "127.0.0.1", port: 4473 },
  oidc: { clientId: "test.apps.googleusercontent.com", clientSecretFile: join(dir, "client-secret"),
    redirectUri: "https://portal.feedback.test:4473/api/v1/auth/callback", domain: "iitgn.ac.in" },
  databases: { portal: loginUrl("portal"), issuer: loginUrl("issuer"), auth: loginUrl("auth"), closer: loginUrl("closer"), retention: loginUrl("retention") },
  keyDirectory: join(dir, "keys"), keyEncryptionKeyFile: join(dir, "kek"), cursorKeyFile: join(dir, "cursor"),
  journalPath: join(dir, "journal.jsonl"), signer: { url: signerUrl, tokenFile: join(dir, "signer-token") }, ...overrides,
});
const respondConfig = (overrides: Partial<RespondConfig> = {}): RespondConfig => ({
  service: "respond", origins, tls: { certFile: join(dir, "tls.crt"), keyFile: join(dir, "tls.key") },
  listen: { host: "127.0.0.1", port: 4474 }, databases: { respond: loginUrl("respond") }, ...overrides,
});
type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string };
function fetchTls(host: "portal" | "respond", path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  const origin = origins[host];
  return new Promise((done, fail) => {
    const req = httpsRequest({ host: "127.0.0.1", port: Number(origin.port), servername: origin.hostname, ca, path, agent: false,
      method: init.method ?? "GET", headers: { host: origin.host, ...init.headers } }, (res) => {
      let body = ""; res.setEncoding("utf8"); res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => done({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", (error) => fail(new Error(`${init.method ?? "GET"} ${path.slice(0, 40)}: ${error.message}`)));
    req.end(init.body);
  });
}
const browserHeaders = (reply: Reply, opener: "same-origin" | "unsafe-none") => {
  expect(reply.headers["content-security-policy"]).toBe(CONTENT_SECURITY_POLICY);
  expect(reply.headers).toMatchObject({ "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
    "x-frame-options": "DENY", "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "strict-transport-security": "max-age=31536000", "cross-origin-opener-policy": opener, "cross-origin-resource-policy": "same-origin" });
};

describe("production servers", () => {
  test("portal serves the bundle and API over TLS with the production header set and request bounds", async () => {
    const server = await startPortalServer(portalConfig(), { frontendDirectory: join(dir, "portal") });
    try {
      const page = await fetchTls("portal", "/");
      expect([page.status, page.headers["cache-control"], page.headers["content-type"]]).toEqual([200, "no-store", "text/html; charset=utf-8"]);
      browserHeaders(page, "same-origin");
      browserHeaders(await fetchTls("portal", "/claim-bridge"), "unsafe-none");
      const asset = await fetchTls("portal", "/assets/app-1a2b.js");
      expect([asset.status, asset.headers["cache-control"], asset.headers["content-type"]]).toEqual([200, "public, max-age=31536000, immutable", "text/javascript; charset=utf-8"]);
      browserHeaders(asset, "same-origin");
      expect(asset.headers.etag).toBeUndefined();
      expect((await fetchTls("portal", "/nowhere")).status).toBe(404);
      const api = await fetchTls("portal", "/api/v1/session");
      expect([api.status, api.headers["cache-control"], JSON.parse(api.body).error.code]).toEqual([401, "no-store", "authentication_required"]);
      browserHeaders(api, "same-origin");
      const login = await fetchTls("portal", "/api/v1/auth/login");
      expect([login.status, new URL(login.headers.location as string).origin]).toEqual([302, "https://accounts.google.com"]);
      expect((await fetchTls("portal", `/?${"a".repeat(2100)}`)).status).toBe(414);
      expect((await fetchTls("portal", "/", { headers: { "x-padding": "a".repeat(9000) } })).status).toBe(431);
      expect((await fetchTls("portal", "/api/v1/polls", { method: "POST", headers: { "content-type": "application/json",
        origin: origins.portal.origin }, body: "{}" })).status).toBe(401);
    } finally { await server.close(); }
  }, 30_000);

  test("response host strips identity, client and tracing headers, sets no cookie, and keeps the bridge opener", async () => {
    let seen: Record<string, unknown> = {};
    const server = await startRespondServer(respondConfig(), { frontendDirectory: join(dir, "respond"),
      beforeListen: (app) => app.addHook("onRequest", async (request) => { seen = { ...request.headers }; }) });
    try {
      const poll = await fetchTls("respond", "/p/123e4567-e89b-42d3-a456-426614174000", { headers: {
        cookie: "__Host-session=portal-cookie", authorization: "Bearer x", "user-agent": "Fingerprint/1.0",
        "x-forwarded-for": "203.0.113.9", forwarded: "for=203.0.113.9", "true-client-ip": "203.0.113.9", "cf-connecting-ip": "203.0.113.9",
        "sec-ch-ua": '"Chromium"', traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01", baggage: "user=1",
        "x-request-id": "abc", accept: "text/html" } });
      expect(poll.status).toBe(200);
      browserHeaders(poll, "unsafe-none");
      expect(Object.keys(seen).sort()).toEqual(["accept", "connection", "host"]);
      expect(poll.headers["set-cookie"]).toBeUndefined();
      expect((await fetchTls("respond", "/p/not-a-poll")).status).toBe(404);
      browserHeaders(await fetchTls("respond", "/"), "same-origin");
      const missing = await fetchTls("respond", "/api/v1/polls/123e4567-e89b-42d3-a456-426614174000/public", { headers: { cookie: "a=b" } });
      expect([missing.status, missing.headers["set-cookie"]]).toEqual([404, undefined]);
      expect((await fetchTls("respond", "/api/v1/polls/123e4567-e89b-42d3-a456-426614174000/responses", { method: "POST",
        headers: { "content-type": "application/json", origin: origins.portal.origin }, body: "{}" })).status).toBe(403);
    } finally { await server.close(); }
  }, 30_000);

  test("startup fails closed on unsafe secrets, roles, journal, signer and bundles", async () => {
    const refuse = async (start: () => Promise<{ close: () => Promise<void> }>, pattern: RegExp) => {
      let message = "";
      try { const server = await start(); await server.close(); } catch (error) { message = (error as Error).message; }
      expect(message).toMatch(pattern);
      expect(message).not.toMatch(new RegExp(Object.values(logins).map((login) => login.password).join("|")));
    };
    const portal = (overrides: Partial<PortalConfig> = {}, frontend = join(dir, "portal")) => () =>
      startPortalServer(portalConfig(overrides), { frontendDirectory: frontend });
    await chmod(join(dir, "kek"), 0o644);
    await refuse(portal(), /FEEDBACK_KEY_ENCRYPTION_KEY_FILE must not be readable/);
    await chmod(join(dir, "kek"), 0o600);
    await refuse(portal({ databases: { ...portalConfig().databases, portal: url } }), /privileged or schema-owning/);
    await refuse(portal({ databases: { ...portalConfig().databases, portal: loginUrl("issuer") } }), /FEEDBACK_PORTAL_DB_URL must be a member of exactly feedback_portal_admin/);
    await refuse(() => startRespondServer(respondConfig({ databases: { respond: loginUrl("portal") } }), { frontendDirectory: join(dir, "respond") }),
      /must be a member of exactly feedback_response_public/);
    healthy = false;
    await refuse(portal(), /signer is not healthy/);
    healthy = true;
    await writeFile(join(dir, "portal", "assets", "demo-9.js"), 'fetch("/__demo/login")');
    await refuse(portal(), /demo authentication/);
    await rm(join(dir, "portal", "assets", "demo-9.js"));
    await mkdir(join(dir, "inline"), { recursive: true });
    await writeFile(join(dir, "inline", "index.html"), "<!doctype html><script>alert(1)</script>");
    await refuse(portal({}, join(dir, "inline")), /inline script/);
    const journal = join(dir, "journal.jsonl");
    await appendJournalEntry(journal, await readJournal(journal), { kind: "purge", pollId: "123e4567-e89b-42d3-a456-426614174000", reason: "draft_deleted" });
    await refuse(portal(), /recovery procedure/);
    await writeFile(journal, "");
    const server = await portal()();
    await server.close();
  }, 60_000);
});
