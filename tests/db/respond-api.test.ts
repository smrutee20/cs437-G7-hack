// POST /api/v1/polls/:id/responses on the response API (SPEC.md §10, §13, §14),
// with the real feedback_response_public role.
import { randomBytes, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, expect, inject, test } from "vitest";
import { createDraft } from "../../services/portal-api/src/create-draft";
import { loadPrivateKey } from "../../services/portal-api/src/keys";
import { migrateFoundation, rollbackFoundation } from "../../services/portal-api/src/migrate";
import { closePoll, openPoll } from "../../services/portal-api/src/poll-lifecycle";
import { createApp } from "../../services/respond-api/src/index";
import { mintCredential } from "../fixtures/mint";

const url = inject("testDatabaseUrl"), master = randomBytes(32), owner = randomUUID();
const respond = "https://respond.feedback.test:4174", portalOrigin = "https://portal.feedback.test:4173";
const observer = new Client({ connectionString: url }), portal = new Client({ connectionString: url });
const apps: ReturnType<typeof createApp>[] = [];
let directory: string;
const ids = { choice: randomUUID(), a: randomUUID(), b: randomUUID(), text: randomUUID() };
const questions = [
  { id: ids.choice, type: "single_choice", prompt: "Pick", required: true, options: [{ id: ids.a, label: "A" }, { id: ids.b, label: "B" }] },
  { id: ids.text, type: "free_text", prompt: "Say", required: false },
];
const answers = (choice = ids.a) => [{ questionId: ids.choice, value: choice }, { questionId: ids.text, value: "Private remark" }];

async function openedPoll() {
  const { id } = await createDraft(portal, owner, { title: "Respond", description: "",
    closesAt: new Date(Date.now() + 86_400_000).toISOString(), questions,
    eligibilityEmails: Array.from({ length: 10 }, (_, i) => `student${i}@iitgn.ac.in`) }, directory, master);
  await openPoll(portal, owner, id, 1);
  const key = (await observer.query("SELECT key_id, public_jwk, private_secret_ref FROM signing_keys WHERE poll_id=$1", [id])).rows[0];
  const der = await loadPrivateKey(directory, master, key.private_secret_ref);
  return { id, mint: () => mintCredential({ keyId: key.key_id, jwk: key.public_jwk, der }, id) };
}
function makeApp(now?: () => number) {
  const app = createApp({ origin: respond, now, acquireClient: async () => {
    const client = new Client({ connectionString: url });
    await client.connect();
    await client.query("SET ROLE feedback_response_public");
    return { client, release: () => client.end() };
  } });
  apps.push(app);
  return app;
}
const post = (app: ReturnType<typeof createApp>, pollId: string, payload: unknown, headers: Record<string, string> = {}, query = "") =>
  app.inject({ method: "POST", url: `/api/v1/polls/${pollId}/responses${query}`,
    payload: typeof payload === "string" || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload),
    headers: { "content-type": "application/json", origin: respond, ...headers } });
const rowCount = async (pollId: string) =>
  (await observer.query("SELECT count(*)::int AS n FROM anonymous.responses WHERE poll_id=$1", [pollId])).rows[0].n;

beforeAll(async () => {
  await migrateFoundation(url);
  directory = await mkdtemp(join(tmpdir(), "feedback-respond-api-"));
  await observer.connect();
  await portal.connect();
  await observer.query(`INSERT INTO identity.users(id,issuer,subject,email,is_organiser)
    VALUES($1,'https://accounts.google.com','respond-owner','owner@iitgn.ac.in',true)`, [owner]);
  await portal.query("SET ROLE feedback_portal_admin");
});
afterAll(async () => {
  await Promise.allSettled(apps.map((app) => app.close()));
  await observer.end();
  await portal.end();
  await rollbackFoundation(url);
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("a credential is accepted once with no identifying echo; the identical retry confirms; no cookie is ever set", async () => {
  const app = makeApp(), poll = await openedPoll();
  const credential = await poll.mint();
  const first = await post(app, poll.id, { credential, answers: answers() });
  expect([first.statusCode, first.json()]).toEqual([201, { status: "accepted" }]);
  expect(first.headers["cache-control"]).toBe("no-store");
  expect(first.headers["set-cookie"]).toBeUndefined();
  // A non-browser client may omit Origin; a cookie is neither needed nor read.
  const retry = await post(app, poll.id, { credential, answers: answers() }, { origin: "", cookie: "__Host-session=unrelated" });
  expect([retry.statusCode, retry.json()]).toEqual([200, { status: "accepted" }]);
  const changed = await post(app, poll.id, { credential, answers: answers(ids.b) });
  expect([changed.statusCode, changed.json().error.code]).toEqual([409, "credential_spent"]);
  for (const reply of [first, retry, changed]) {
    expect(reply.body).not.toContain(credential.signature.slice(0, 40));
    expect(reply.body).not.toContain("Private remark");
  }
  expect(await rowCount(poll.id)).toBe(1);
});

test("framing, origin, encoding and size are checked before any work", async () => {
  const app = makeApp(), poll = await openedPoll();
  const credential = await poll.mint();
  const body = JSON.stringify({ credential, answers: answers() });
  const cases: [string, Promise<{ statusCode: number; json: () => { error: { code: string } } }>, number, string][] = [
    ["portal origin", post(app, poll.id, body, { origin: portalOrigin }), 403, "forbidden"],
    ["text/plain", post(app, poll.id, body, { "content-type": "text/plain" }), 415, "unsupported_media_type"],
    ["gzip body", post(app, poll.id, gzipSync(body), { "content-encoding": "gzip" }), 415, "unsupported_media_type"],
    ["credential in the query", post(app, poll.id, body, {}, `?credential=${credential.signature.slice(0, 20)}`), 400, "invalid_request"],
    ["duplicate member", post(app, poll.id, body.replace("{", '{"answers":[],')), 400, "invalid_request"],
    ["over 64 KiB", post(app, poll.id, { credential, answers: answers(), pad: "x".repeat(65 * 1024) }), 413, "payload_too_large"],
    ["unknown poll", post(app, randomUUID(), body), 404, "not_found"],
  ];
  for (const [name, reply, status, code] of cases) {
    const result = await reply;
    expect([name, result.statusCode, result.json().error.code]).toEqual([name, status, code]);
  }
  expect(await rowCount(poll.id)).toBe(0);
  expect((await post(app, poll.id, body)).statusCode).toBe(201); // none of the above spent it
});

test("credential, answer and lifecycle failures map to the documented statuses", async () => {
  const app = makeApp(), poll = await openedPoll();
  const credential = await poll.mint();
  const tampered = { ...credential, signature: Buffer.from(credential.signature, "base64url").map((b, i) => (i === 9 ? b ^ 1 : b)) };
  const bad = await post(app, poll.id, { credential: { ...credential, signature: Buffer.from(tampered.signature).toString("base64url") }, answers: answers() });
  expect([bad.statusCode, bad.json()]).toEqual([400, { error: { code: "invalid_credential", message: "invalid credential" } }]);
  const invalid = await post(app, poll.id, { credential, answers: [{ questionId: ids.text, value: "only text" }] });
  expect([invalid.statusCode, invalid.json().error]).toEqual([422, { code: "validation_failed", message: "validation failed", field: "answers" }]);
  expect(invalid.body).not.toContain("only text");
  await closePoll(portal, owner, poll.id);
  const late = await post(app, poll.id, { credential, answers: answers() });
  expect([late.statusCode, late.json().error.code]).toEqual([410, "poll_closed"]);
  expect(await rowCount(poll.id)).toBe(0);
});

test("submissions are rate limited per poll and globally, keyed by poll ID only", async () => {
  const frozen = () => 1_000_000; // no refill between requests: the bucket boundary is exact
  const app = makeApp(frozen), poll = await openedPoll(), other = await openedPoll();
  const junk = { credential: {}, answers: [] }; // cheap requests: limits apply before parsing or crypto
  for (let i = 0; i < 10; i++) expect((await post(app, poll.id, junk)).statusCode).toBe(400);
  const limited = await post(app, poll.id, junk);
  expect([limited.statusCode, limited.json().error.code]).toEqual([429, "rate_limited"]);
  expect(limited.headers["retry-after"]).toMatch(/^[1-9][0-9]*$/);
  expect((await post(app, other.id, junk)).statusCode).toBe(400); // another poll is unaffected

  const global = makeApp(frozen);
  const statuses: number[] = [];
  for (let i = 0; i < 41; i++) statuses.push((await post(global, randomUUID(), junk)).statusCode);
  expect(statuses.slice(0, 40).every((status) => status === 400)).toBe(true);
  expect(statuses[40]).toBe(429);
});
