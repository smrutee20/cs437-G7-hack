// POST /api/v1/polls/:id/claim through the portal app with a real issuer DB role.
// The signer double is an independent OpenSSL raw operation; the real signer
// client is exercised against workerd in tests/signer/signer-client.test.ts.
import { createPrivateKey, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, expect, inject, test } from "vitest";
import {
  blindMessage, finalizeSignature, importPollPublicKey, prepareMessage, verifySignature,
} from "../../packages/protocol/src/blind";
import { encodeApplicationMessage } from "../../packages/protocol/src/credential";
import { createApp } from "../../services/portal-api/src/index";
import { migrateFoundation, rollbackFoundation } from "../../services/portal-api/src/migrate";
import { nodeRawSign } from "../fixtures/rsa";

const url = inject("testDatabaseUrl"), origin = "https://portal.feedback.test:4173";
const observer = new Client({ connectionString: url });
const people = ["owner", "alice", "bob", "carol", "dave", "erin"] as const;
type Person = typeof people[number];
const ids = Object.fromEntries(people.map((name) => [name, randomUUID()])) as Record<Person, string>;
const email = (name: Person) => ({ owner: "owner@iitgn.ac.in", alice: "student0@iitgn.ac.in", bob: "student1@iitgn.ac.in",
  carol: "unlisted@iitgn.ac.in", dave: "student2@iitgn.ac.in", erin: "student3@iitgn.ac.in" })[name];
const sessions = new Map(people.map((name) => [name,
  { id: ids[name], email: email(name), isOrganiser: name === "owner", csrfToken: `${name}-csrf` }]));
const signer = { healthy: true, fail: false, signs: 0 };
let directory: string, app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await migrateFoundation(url);
  directory = await mkdtemp(join(tmpdir(), "feedback-claim-api-"));
  await observer.connect();
  for (const name of people) {
    await observer.query(`INSERT INTO identity.users(id,issuer,subject,email,is_organiser)
      VALUES($1,'https://accounts.google.com',$2,$3,$4)`, [ids[name], `claim-api-${name}`, email(name), name === "owner"]);
  }
  const connect = (role: string) => async () => {
    const client = new Client({ connectionString: url });
    await client.connect();
    await client.query(`SET ROLE ${role}`);
    return { client, release: () => client.end() };
  };
  app = createApp({
    origin, keyDirectory: directory, encryptionKey: randomBytes(32), cursorKey: randomBytes(32),
    authenticate: async (request) =>
      sessions.get(/(?:^|; )__Host-session=([^;]+)/.exec(request.headers.cookie ?? "")?.[1] as Person) ?? null,
    acquireClient: connect("feedback_portal_admin"),
    issuer: {
      acquireClient: connect("feedback_issuer"),
      signer: {
        healthy: async () => signer.healthy,
        sign: async (key: Buffer, blinded: Uint8Array) => {
          signer.signs++;
          if (signer.fail) throw new Error("signer unavailable");
          return nodeRawSign(createPrivateKey({ key, format: "der", type: "pkcs8" }), blinded);
        },
      },
    },
  });
});
afterAll(async () => {
  await app?.close();
  await observer.end();
  await rollbackFoundation(url);
  if (directory) await rm(directory, { recursive: true, force: true });
});

const send = (who: string, method: "GET" | "POST", path: string, payload?: unknown,
  headers: Record<string, string> = {}) => app.inject({
  method, url: `/api/v1${path}`, payload: payload === undefined ? undefined : JSON.stringify(payload),
  headers: { cookie: `__Host-session=${who}`, origin, "x-csrf-token": `${who}-csrf`,
    "content-type": "application/json", ...headers },
});
async function openPoll() {
  const created = await send("owner", "POST", "/polls", {
    title: "Claim route", description: "", closesAt: new Date(Date.now() + 86400000).toISOString(),
    questions: [{ id: randomUUID(), type: "rating", prompt: "Score?", required: true }],
    eligibilityEmails: Array.from({ length: 10 }, (_, i) => `student${i}@iitgn.ac.in`),
  });
  expect(created.statusCode).toBe(201);
  expect((await send("owner", "POST", `/polls/${created.json().id}/open`, { revision: 1 })).statusCode).toBe(200);
  return created.json().id as string;
}
// What the bridge does: fetch public claim context on the portal origin, then blind on the response origin.
async function blindRequest(who: Person, pollId: string) {
  const context = (await send(who, "GET", `/polls/${pollId}/claim-context`)).json();
  const key = await importPollPublicKey(context.key.publicJwk);
  const prepared = prepareMessage(encodeApplicationMessage(pollId, randomBytes(32)));
  const { blindedMessage, inverse } = await blindMessage(key, prepared);
  return { key, prepared, inverse, body: { keyId: context.key.keyId, keyVersion: 1,
    blindedMessage: Buffer.from(blindedMessage).toString("base64url") } };
}
const claims = async (pollId: string) =>
  (await observer.query("SELECT count(*)::int AS count FROM identity.claims WHERE poll_id=$1", [pollId])).rows[0].count;

test("an eligible participant claims once through the guarded route and receives only a blind signature", async () => {
  const pollId = await openPoll();
  const attempt = await blindRequest("alice", pollId);
  const path = `/polls/${pollId}/claim`;
  expect((await send("alice", "POST", path, attempt.body, { "x-csrf-token": "wrong" })).statusCode).toBe(403);
  expect((await send("alice", "POST", path, attempt.body, { origin: "https://respond.feedback.test:4174" })).statusCode).toBe(403);
  expect((await send("alice", "POST", path, attempt.body, { "content-type": "text/plain" })).statusCode).toBe(415);
  expect((await send("nobody", "POST", path, attempt.body)).statusCode).toBe(401);
  const oversized = await send("alice", "POST", path, { ...attempt.body, padding: "x".repeat(2048) });
  expect(oversized.statusCode).toBe(413);
  expect(oversized.json()).toMatchObject({ error: { code: "payload_too_large" } });
  expect(await claims(pollId)).toBe(0);
  expect(signer.signs).toBe(0);

  const issued = await send("alice", "POST", path, attempt.body);
  expect(issued.statusCode).toBe(201);
  expect(issued.headers["cache-control"]).toBe("no-store");
  expect(Object.keys(issued.json())).toEqual(["blindSignature"]);
  const signature = await finalizeSignature(attempt.key, attempt.prepared,
    Buffer.from(issued.json().blindSignature, "base64url"), attempt.inverse);
  expect(await verifySignature(attempt.key, attempt.prepared, signature)).toBe(true);
  expect(await claims(pollId)).toBe(1);

  const again = await send("alice", "POST", path, (await blindRequest("alice", pollId)).body);
  expect(again.statusCode).toBe(409);
  expect(again.json()).toEqual({ error: { code: "claim_consumed", message: "claim consumed" } });
  expect(again.body).not.toContain(email("alice"));
  expect(signer.signs).toBe(1);
});

test("claim outcomes map to the documented statuses without consuming entitlements before commit", async () => {
  const pollId = await openPoll(), closedId = await openPoll();
  expect((await send("owner", "POST", `/polls/${closedId}/close`, {})).statusCode).toBe(200);
  const body = (await blindRequest("bob", pollId)).body;
  const status = async (who: Person, id: string, payload: unknown) => {
    const reply = await send(who, "POST", `/polls/${id}/claim`, payload);
    expect(reply.body).not.toContain(body.blindedMessage);
    return [reply.statusCode, reply.json().error?.code ?? "ok"];
  };
  expect(await status("bob", pollId, { ...body, keyVersion: 2 })).toEqual([400, "invalid_request"]);
  expect(await status("bob", randomUUID(), body)).toEqual([404, "not_found"]);
  expect(await status("bob", closedId, (await blindRequest("bob", closedId)).body)).toEqual([410, "poll_closed"]);
  expect(await status("carol", pollId, body)).toEqual([403, "not_eligible"]);
  signer.healthy = false;
  expect(await status("erin", pollId, (await blindRequest("erin", pollId)).body)).toEqual([503, "capacity_unavailable"]);
  signer.healthy = true;
  expect(await claims(pollId)).toBe(0);
  expect(await status("erin", pollId, (await blindRequest("erin", pollId)).body)).toEqual([201, "ok"]);
  signer.fail = true;
  try {
    expect(await status("dave", pollId, (await blindRequest("dave", pollId)).body))
      .toEqual([503, "claim_consumed_no_credential"]);
  } finally { signer.fail = false; }
  expect(await claims(pollId)).toBe(2);
  expect(await status("dave", pollId, (await blindRequest("dave", pollId)).body)).toEqual([409, "claim_consumed"]);
});

test("an account's sixth claim attempt within a minute is refused with an integer Retry-After", async () => {
  const pollId = await openPoll();
  const body = (await blindRequest("carol", pollId)).body;
  for (let i = 0; i < 4; i++) { // carol already made one attempt in the previous test
    expect((await send("carol", "POST", `/polls/${pollId}/claim`, body)).statusCode).toBe(403);
  }
  const limited = await send("carol", "POST", `/polls/${pollId}/claim`, body);
  expect(limited.statusCode).toBe(429);
  expect(limited.json()).toMatchObject({ error: { code: "rate_limited" } });
  expect(limited.headers["retry-after"]).toMatch(/^[1-9][0-9]*$/);
  // Another account is unaffected.
  expect((await send("bob", "POST", `/polls/${pollId}/claim`, (await blindRequest("bob", pollId)).body)).statusCode).toBe(201);
});
