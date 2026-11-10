// SPEC.md §14 draft/key creation bounds: ten per organiser per day (invalid
// input never spends it), at most 50 retained polls per organiser.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, expect, inject, test } from "vitest";
import { createApp } from "../../services/portal-api/src/index";
import { migrateFoundation, rollbackFoundation } from "../../services/portal-api/src/migrate";

const url = inject("testDatabaseUrl"), origin = "https://portal.feedback.test:4173";
const busy = randomUUID(), full = randomUUID();
let keys: string, app: ReturnType<typeof createApp>, clock = Date.now();
const observer = new Client({ connectionString: url });
const draft = (title = "Limit") => ({ title, description: "", closesAt: new Date(Date.now() + 86_400_000).toISOString(),
  questions: [{ id: randomUUID(), type: "rating", prompt: "Score?", required: true }],
  eligibilityEmails: Array.from({ length: 10 }, (_, i) => `limit${i}@iitgn.ac.in`) });
const create = (who: string, body: unknown) => app.inject({ method: "POST", url: "/api/v1/polls", payload: JSON.stringify(body),
  headers: { cookie: `__Host-session=${who}`, origin, "x-csrf-token": "csrf", "content-type": "application/json" } });

beforeAll(async () => {
  await migrateFoundation(url);
  await observer.connect();
  keys = await mkdtemp(join(tmpdir(), "feedback-limits-"));
  await observer.query(`INSERT INTO identity.users(id,issuer,subject,email,is_organiser) VALUES
    ($1,'https://accounts.google.com','limit-busy','busy@iitgn.ac.in',true),($2,'https://accounts.google.com','limit-full','full@iitgn.ac.in',true)`, [busy, full]);
  app = createApp({ origin, keyDirectory: keys, encryptionKey: randomBytes(32), cursorKey: randomBytes(32), now: () => clock,
    authenticate: async (request) => ({ id: request.headers.cookie?.includes("full") ? full : busy, isOrganiser: true, csrfToken: "csrf" }),
    acquireClient: async () => {
      const client = new Client({ connectionString: url });
      await client.connect();
      await client.query("SET ROLE feedback_portal_admin");
      return { client, release: () => client.end() };
    } });
});
afterAll(async () => { await app?.close(); await observer.end(); await rollbackFoundation(url); if (keys) await rm(keys, { recursive: true, force: true }); });

test("ten key-generating creations per organiser per day; invalid drafts do not count", async () => {
  const invalid = { ...draft(), eligibilityEmails: [] };
  for (let i = 0; i < 3; i++) expect((await create("busy", invalid)).statusCode).toBe(422);
  for (let i = 0; i < 10; i++) expect((await create("busy", draft(`Busy ${i}`))).statusCode).toBe(201);
  const limited = await create("busy", draft("Eleventh"));
  expect(limited.statusCode).toBe(429);
  expect(limited.json().error.code).toBe("rate_limited");
  expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
  expect(await readdir(keys)).toHaveLength(10);
  clock += 86_400_001;
  expect((await create("busy", draft("Next day"))).statusCode).toBe(201);
}, 90_000);

test("at most fifty retained polls per organiser, refused before any key remains", async () => {
  await observer.query(`INSERT INTO polls(id,organiser_id,title,description,closes_at,questions)
    SELECT gen_random_uuid(), $1, 'Existing', '', clock_timestamp() + interval '1 day', '[]'::jsonb FROM generate_series(1, 49)`, [full]);
  const before = (await readdir(keys)).length;
  expect((await create("full", draft("Fiftieth"))).statusCode).toBe(201);
  const refused = await create("full", draft("Fifty-first"));
  expect([refused.statusCode, refused.json().error]).toEqual([422, { code: "validation_failed", message: "validation failed", field: "retainedPolls" }]);
  expect(await readdir(keys)).toHaveLength(before + 1);
}, 60_000);
