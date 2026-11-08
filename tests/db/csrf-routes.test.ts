// SPEC.md §5 / scenario 4: every authenticated mutation (create, update, open, close,
// delete, claim, logout) requires the exact portal Origin and the session-bound CSRF
// token, and a refused request changes nothing.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, expect, inject, test } from "vitest";
import { createApp } from "../../services/portal-api/src/index";
import { createSessionStore } from "../../services/portal-api/src/auth";
import { migrateFoundation, rollbackFoundation } from "../../services/portal-api/src/migrate";

const url = inject("testDatabaseUrl"), origin = "https://portal.feedback.test:4173", owner = randomUUID();
let keys: string, journalDir: string, app: ReturnType<typeof createApp>;
const lease = (role: string) => async () => {
  const client = new Client({ connectionString: url }); await client.connect(); await client.query(`SET ROLE ${role}`);
  return { client, release: () => client.end() };
};
const draft = () => ({ title: "CSRF", description: "", closesAt: new Date(Date.now() + 86_400_000).toISOString(),
  questions: [{ id: randomUUID(), type: "rating", prompt: "Q", required: true }],
  eligibilityEmails: Array.from({ length: 10 }, (_, i) => `c${i}@iitgn.ac.in`) });

beforeAll(async () => {
  await migrateFoundation(url);
  keys = await mkdtemp(join(tmpdir(), "feedback-csrf-")); journalDir = await mkdtemp(join(tmpdir(), "feedback-csrf-journal-"));
  const admin = new Client({ connectionString: url }); await admin.connect();
  try { await admin.query(`INSERT INTO identity.users(id,issuer,subject,email,is_organiser) VALUES($1,'https://accounts.google.com','csrf-owner','csrf@iitgn.ac.in',true)`, [owner]); }
  finally { await admin.end(); }
  app = createApp({ origin, keyDirectory: keys, encryptionKey: randomBytes(32), cursorKey: randomBytes(32), journalPath: join(journalDir, "j.jsonl"),
    authenticate: async () => ({ id: owner, email: "csrf@iitgn.ac.in", isOrganiser: true, csrfToken: "right-token" }),
    acquireClient: lease("feedback_portal_admin"),
    auth: { store: createSessionStore(lease("feedback_auth")), acquireClient: lease("feedback_auth") },
    issuer: { acquireClient: lease("feedback_issuer"), signer: { healthy: async () => true, sign: async () => { throw new Error("never"); } } } });
});
afterAll(async () => { await app?.close(); await rollbackFoundation(url); for (const dir of [keys, journalDir]) if (dir) await rm(dir, { recursive: true, force: true }); });

test("every mutation route refuses a wrong or missing CSRF token and a foreign or missing Origin, changing nothing", async () => {
  const good = { origin, "x-csrf-token": "right-token", "content-type": "application/json" };
  const created = await app.inject({ method: "POST", url: "/api/v1/polls", headers: good, payload: JSON.stringify(draft()) });
  expect(created.statusCode).toBe(201);
  const id = created.json().id;
  const routes: { method: "POST" | "PUT" | "DELETE"; url: string; body: unknown }[] = [
    { method: "POST", url: "/api/v1/polls", body: draft() },
    { method: "PUT", url: `/api/v1/polls/${id}`, body: { revision: 1, draft: { ...draft(), title: "Changed" } } },
    { method: "POST", url: `/api/v1/polls/${id}/open`, body: { revision: 1 } },
    { method: "POST", url: `/api/v1/polls/${id}/close`, body: {} },
    { method: "DELETE", url: `/api/v1/polls/${id}`, body: {} },
    { method: "POST", url: `/api/v1/polls/${id}/claim`, body: { keyId: randomUUID(), keyVersion: 1, blindedMessage: "AA" } },
    { method: "POST", url: "/api/v1/auth/logout", body: {} },
  ];
  const variants: [string, Record<string, string>][] = [
    ["wrong CSRF", { ...good, "x-csrf-token": "wrong-token" }],
    ["missing CSRF", { origin, "content-type": "application/json" }],
    ["foreign Origin", { ...good, origin: "https://respond.feedback.test:4174" }],
    ["missing Origin", { "x-csrf-token": "right-token", "content-type": "application/json" }],
    ["lookalike Origin", { ...good, origin: "https://portal.feedback.test:4173.evil.example" }],
  ];
  for (const route of routes) {
    for (const [label, headers] of variants) {
      const response = await app.inject({ method: route.method, url: route.url, headers, payload: JSON.stringify(route.body) });
      expect([response.statusCode, response.json().error.code], `${route.method} ${route.url} with ${label}`).toEqual([403, "csrf_failed"]);
    }
  }
  const after = (await app.inject({ method: "GET", url: `/api/v1/polls/${id}` })).json();
  expect(after).toMatchObject({ title: "CSRF", status: "draft", revision: 1 });
  expect((await app.inject({ method: "GET", url: "/api/v1/polls" })).json().items).toHaveLength(1);
});
