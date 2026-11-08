// GET /api/v1/polls/:id/results on the portal (SPEC.md §11, §13): owner only,
// no counts before closure, no filters, and only the result DTO.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, expect, inject, test } from "vitest";
import { createApp } from "../../services/portal-api/src/index";
import { loadPrivateKey } from "../../services/portal-api/src/keys";
import { migrateFoundation, rollbackFoundation } from "../../services/portal-api/src/migrate";
import { redeemResponse } from "../../services/respond-api/src/redeem";
import { mintCredential } from "../fixtures/mint";

const url = inject("testDatabaseUrl"), origin = "https://portal.feedback.test:4173", master = randomBytes(32);
const owner = randomUUID(), other = randomUUID();
const sessions = new Map([
  ["owner", { id: owner, email: "owner@iitgn.ac.in", isOrganiser: true, csrfToken: "owner-csrf" }],
  ["other", { id: other, email: "other@iitgn.ac.in", isOrganiser: true, csrfToken: "other-csrf" }],
]);
const observer = new Client({ connectionString: url }), publicDb = new Client({ connectionString: url });
let directory: string, app: ReturnType<typeof createApp>;
const choice = { id: randomUUID(), type: "single_choice", prompt: "Pick", required: true,
  options: [{ id: randomUUID(), label: "A" }, { id: randomUUID(), label: "B" }] };

beforeAll(async () => {
  await migrateFoundation(url);
  directory = await mkdtemp(join(tmpdir(), "feedback-results-api-"));
  await observer.connect();
  await publicDb.connect();
  await publicDb.query("SET ROLE feedback_response_public");
  await observer.query(`INSERT INTO identity.users(id,issuer,subject,email,is_organiser) VALUES
    ($1,'https://accounts.google.com','ra-owner','owner@iitgn.ac.in',true),($2,'https://accounts.google.com','ra-other','other@iitgn.ac.in',true)`,
    [owner, other]);
  app = createApp({ origin, keyDirectory: directory, encryptionKey: master, cursorKey: randomBytes(32),
    authenticate: async (request) => sessions.get(/(?:^|; )__Host-session=([^;]+)/.exec(request.headers.cookie ?? "")?.[1] ?? "") ?? null,
    acquireClient: async () => {
      const client = new Client({ connectionString: url });
      await client.connect();
      await client.query("SET ROLE feedback_portal_admin");
      return { client, release: () => client.end() };
    } });
});
afterAll(async () => {
  await app?.close();
  await observer.end();
  await publicDb.end();
  await rollbackFoundation(url);
  if (directory) await rm(directory, { recursive: true, force: true });
});
const send = (who: string, method: "GET" | "POST", path: string, payload?: unknown) => app.inject({ method, url: `/api/v1${path}`,
  payload: payload === undefined ? undefined : JSON.stringify(payload),
  headers: { cookie: `__Host-session=${who}`, origin, "x-csrf-token": `${who}-csrf`, "content-type": "application/json" } });

test("results are owner-only, closed-only, filter-free, and expose only the result DTO", async () => {
  const created = (await send("owner", "POST", "/polls", { title: "Results route", description: "",
    closesAt: new Date(Date.now() + 86_400_000).toISOString(), questions: [choice],
    eligibilityEmails: Array.from({ length: 10 }, (_, i) => `student${i}@iitgn.ac.in`) })).json();
  expect((await send("owner", "POST", `/polls/${created.id}/open`, { revision: 1 })).statusCode).toBe(200);
  const key = (await observer.query("SELECT key_id, public_jwk, private_secret_ref FROM signing_keys WHERE poll_id=$1", [created.id])).rows[0];
  const der = await loadPrivateKey(directory, master, key.private_secret_ref);
  for (let i = 0; i < 5; i++) {
    const credential = await mintCredential({ keyId: key.key_id, jwk: key.public_jwk, der }, created.id);
    await redeemResponse(publicDb, created.id, { credential, answers: [{ questionId: choice.id, value: choice.options[i % 2].id }] });
  }
  const early = await send("owner", "GET", `/polls/${created.id}/results`);
  expect([early.statusCode, early.json()]).toEqual([409, { error: { code: "results_not_closed", message: "results not closed" } }]);
  expect(early.body).not.toMatch(/count|total|5/i);
  expect((await send("other", "GET", `/polls/${created.id}/results`)).statusCode).toBe(404);
  expect((await send("nobody", "GET", `/polls/${created.id}/results`)).statusCode).toBe(401);
  expect((await send("owner", "POST", `/polls/${created.id}/close`, {})).statusCode).toBe(200);
  expect((await send("owner", "GET", `/polls/${created.id}/results?question=${choice.id}`)).statusCode).toBe(400);
  const ready = await send("owner", "GET", `/polls/${created.id}/results`);
  expect(ready.statusCode).toBe(200);
  expect(ready.headers["cache-control"]).toBe("no-store");
  expect(ready.json()).toEqual({ state: "ready", totalResponses: 5, questions: [{ questionId: choice.id, state: "published",
    type: "single_choice", answeredCount: 5, skippedCount: 0, options: [
      { optionId: choice.options[0].id, count: 3, percentage: 60 }, { optionId: choice.options[1].id, count: 2, percentage: 40 }] }] });
  // The owner DTO and list still carry no response or claim counts.
  expect(JSON.stringify((await send("owner", "GET", `/polls/${created.id}`)).json())).not.toMatch(/responseCount|claimCount|totalResponses|answeredCount|claimed/i);
  await observer.query("UPDATE polls SET invalidated=true WHERE id=$1", [created.id]);
  const withdrawn = await send("owner", "GET", `/polls/${created.id}/results`);
  expect([withdrawn.statusCode, withdrawn.json().error.code]).toEqual([410, "poll_withdrawn"]);
});
