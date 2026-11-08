// SPEC.md §15 / §17 scenario 19: error, rejection and failure paths write nothing to
// process output, and response bodies never echo credentials, answers, emails, codes
// or exception text. The disposable PostgreSQL server is configured so its own log
// cannot retain statements, parameters or key values from error DETAIL lines.
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, expect, inject, test } from "vitest";
import { createApp as portalApp } from "../../services/portal-api/src/index";
import { createSessionStore } from "../../services/portal-api/src/auth";
import { migrateFoundation, rollbackFoundation } from "../../services/portal-api/src/migrate";
import { createApp as respondApp } from "../../services/respond-api/src/index";

const url = inject("testDatabaseUrl"), origin = "https://portal.feedback.test:4173", respondOrigin = "https://respond.feedback.test:4174";
const SENTINEL = `sentinel${randomBytes(6).toString("hex")}`;
const owner = randomUUID();
let keys: string;
const lease = (role: string, fail = false) => async () => {
  if (fail) throw new Error(`connection refused ${SENTINEL}`);
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query(`SET ROLE ${role}`);
  return { client, release: () => client.end() };
};

/** Pino writes straight to the file descriptor (not process.stdout.write), so assert no request logger exists at all. */
const noLogger = (app: { log: unknown }) => expect((app.log as { level?: string }).level, "Fastify request logger must be disabled").toBeUndefined();

/** Records every byte written to stdout/stderr and every console call while `action` runs. */
async function captureOutput(action: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const writes = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
  const consoleMethods = ["log", "info", "warn", "error", "debug", "trace"] as const;
  const saved = consoleMethods.map((name) => console[name]);
  process.stdout.write = ((chunk: unknown) => { chunks.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => { chunks.push(String(chunk)); return true; }) as typeof process.stderr.write;
  consoleMethods.forEach((name) => { console[name] = (...args: unknown[]) => { chunks.push(args.map(String).join(" ")); }; });
  try { await action(); } finally {
    process.stdout.write = writes.out; process.stderr.write = writes.err;
    consoleMethods.forEach((name, i) => { console[name] = saved[i]; });
  }
  return chunks.join("");
}

beforeAll(async () => {
  await migrateFoundation(url);
  keys = await mkdtemp(join(tmpdir(), "feedback-logging-"));
  const admin = new Client({ connectionString: url }); await admin.connect();
  try {
    await admin.query(`INSERT INTO identity.users(id,issuer,subject,email,is_organiser) VALUES($1,'https://accounts.google.com','log-owner','log.owner@iitgn.ac.in',true)`, [owner]);
  } finally { await admin.end(); }
});
afterAll(async () => { await rollbackFoundation(url); if (keys) await rm(keys, { recursive: true, force: true }); });

test("the disposable PostgreSQL server keeps no statements, parameters or error details", async () => {
  const client = new Client({ connectionString: url }); await client.connect();
  try {
    const settings = Object.fromEntries((await client.query(`SELECT name, setting FROM pg_settings WHERE name IN
      ('log_statement','log_min_error_statement','log_min_messages','log_error_verbosity','log_parameter_max_length_on_error',
       'log_min_duration_statement','log_connections','log_disconnections')`)).rows.map((row) => [row.name, row.setting]));
    expect(settings).toEqual({ log_statement: "none", log_min_error_statement: "panic", log_min_messages: "fatal",
      log_error_verbosity: "terse", log_parameter_max_length_on_error: "0", log_min_duration_statement: "-1",
      log_connections: "off", log_disconnections: "off" });
    const since = new Date(Date.now() - 1000).toISOString();
    await expect(client.query(`SELECT '${SENTINEL}'::int`)).rejects.toThrow();
    await expect(client.query("SELECT $1::int", [SENTINEL])).rejects.toThrow();
    const pollId = randomUUID();
    await client.query(`INSERT INTO polls(id,organiser_id,title,description,closes_at,questions) VALUES($1,$2,'t','',now()+interval '1 day','[]')`, [pollId, owner]);
    await client.query("INSERT INTO identity.eligibility(poll_id,email) VALUES($1,$2)", [pollId, `${SENTINEL}@iitgn.ac.in`]);
    await expect(client.query("INSERT INTO identity.eligibility(poll_id,email) VALUES($1,$2)", [pollId, `${SENTINEL}@iitgn.ac.in`])).rejects.toThrow();
    // Positive control: FATAL lines are still logged, so the scan below does read the server log.
    const control = `control${randomBytes(6).toString("hex")}`;
    const missing = new Client({ connectionString: Object.assign(new URL(url), { pathname: `/${control}` }).href });
    await expect(missing.connect()).rejects.toThrow();
    await new Promise((done) => setTimeout(done, 500));
    let log: string;
    try {
      log = execFileSync("docker", ["compose", "logs", "--no-color", "--since", since, "postgres"], { cwd: join(import.meta.dirname, "../.."), encoding: "utf8" });
    } catch {
      throw new Error("SETUP ERROR: `docker compose logs postgres` is unavailable; the server-log review needs the Compose service. This is not a test result.");
    }
    expect(log).toContain(control);
    expect(log).not.toContain(SENTINEL);
  } finally { await client.end(); }
});

test("portal error paths write nothing to process output and echo nothing sensitive", async () => {
  const store = createSessionStore(lease("feedback_auth"));
  const session = { id: owner, email: "log.owner@iitgn.ac.in", isOrganiser: true, csrfToken: "csrf" };
  const app = portalApp({ origin, keyDirectory: keys, encryptionKey: randomBytes(32), cursorKey: randomBytes(32),
    authenticate: async () => session, acquireClient: lease("feedback_portal_admin"),
    auth: { store, acquireClient: lease("feedback_auth"), oidc: { clientId: "c.apps.googleusercontent.com", clientSecret: "s",
      redirectUri: `${origin}/api/v1/auth/callback`, domain: "iitgn.ac.in", certs: async () => ({}),
      exchangeCode: async () => { throw new Error(`token endpoint said ${SENTINEL}`); } } } });
  const broken = portalApp({ origin, keyDirectory: keys, encryptionKey: randomBytes(32), cursorKey: randomBytes(32),
    authenticate: async () => session, acquireClient: lease("feedback_portal_admin", true) });
  noLogger(app); noLogger(broken);
  const headers = { origin, "x-csrf-token": "csrf", "content-type": "application/json" };
  const bodies: string[] = [];
  const output = await captureOutput(async () => {
    const draft = { title: "Log", description: "", closesAt: new Date(Date.now() + 86_400_000).toISOString(),
      questions: [{ id: randomUUID(), type: "rating", prompt: "Q", required: true }],
      eligibilityEmails: [...Array.from({ length: 9 }, (_, i) => `l${i}@iitgn.ac.in`), `${SENTINEL}@example.org`] };
    for (const request of [
      { method: "POST" as const, url: "/api/v1/polls", payload: JSON.stringify(draft) },
      { method: "POST" as const, url: "/api/v1/polls", payload: `{"title":"${SENTINEL}",` },
      { method: "POST" as const, url: `/api/v1/polls/${randomUUID()}/open`, payload: JSON.stringify({ revision: SENTINEL }) },
      { method: "GET" as const, url: `/api/v1/polls/${SENTINEL}` },
      { method: "GET" as const, url: `/api/v1/polls?cursor=${SENTINEL}` },
    ]) bodies.push((await app.inject({ ...request, headers })).body);
    const login = await app.inject({ method: "GET", url: "/api/v1/auth/login" });
    const preauth = /__Host-preauth=([^;]+)/.exec(String(login.headers["set-cookie"]))![1];
    const state = new URL(login.headers.location as string).searchParams.get("state");
    const callback = await app.inject({ method: "GET", url: `/api/v1/auth/callback?code=${SENTINEL}&state=${state}`, headers: { cookie: `__Host-preauth=${preauth}` } });
    expect(callback.headers.location).toBe("/?signin=failed");
    bodies.push(callback.body, JSON.stringify(callback.headers));
    const failed = await broken.inject({ method: "GET", url: "/api/v1/polls" });
    expect([failed.statusCode, failed.json()]).toEqual([500, { error: { code: "internal_error", message: "internal error" } }]);
    bodies.push(failed.body);
  });
  await app.close(); await broken.close();
  expect(output).toBe("");
  for (const body of bodies) expect(body).not.toContain(SENTINEL);
});

test("response-service error paths write nothing to process output and echo nothing sensitive", async () => {
  const app = respondApp({ origin: respondOrigin, acquireClient: lease("feedback_response_public") });
  const broken = respondApp({ origin: respondOrigin, acquireClient: lease("feedback_response_public", true) });
  noLogger(app); noLogger(broken);
  const pollId = randomUUID();
  const credential = { version: 1, keyId: randomUUID(), keyVersion: 1, preparedMessage: SENTINEL, signature: SENTINEL };
  const bodies: string[] = [];
  const output = await captureOutput(async () => {
    const send = (target: typeof app, payload: string) => target.inject({ method: "POST", url: `/api/v1/polls/${pollId}/responses`, payload,
      headers: { "content-type": "application/json", origin: respondOrigin, cookie: `__Host-session=${SENTINEL}`, "user-agent": SENTINEL } });
    for (const payload of [JSON.stringify({ credential, answers: [{ questionId: randomUUID(), value: SENTINEL }] }), `{"credential":"${SENTINEL}"`,
      JSON.stringify({ credential, answers: [], extra: SENTINEL })]) {
      bodies.push((await send(app, payload)).body);
    }
    const failed = await send(broken, JSON.stringify({ credential, answers: [] }));
    bodies.push(failed.body);
    bodies.push((await app.inject({ method: "GET", url: `/api/v1/polls/${SENTINEL}/public` })).body);
    bodies.push((await broken.inject({ method: "GET", url: `/api/v1/polls/${pollId}/public` })).body);
  });
  await app.close(); await broken.close();
  expect(output).toBe("");
  for (const body of bodies) expect(body).not.toContain(SENTINEL);
});
