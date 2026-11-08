// Milestone 4 redemption against real PostgreSQL (SPEC.md §4, §7, §10). Credentials
// are minted in Node with an independent OpenSSL raw signature; the expected
// nullifier and advisory-lock key are computed here from the spec definitions.
import { createHash, createPrivateKey, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, expect, inject, test } from "vitest";
import { blindMessage, finalizeSignature, importPollPublicKey, prepareMessage } from "../../packages/protocol/src/blind";
import { encodeApplicationMessage } from "../../packages/protocol/src/credential";
import { createDraft } from "../../services/portal-api/src/create-draft";
import { loadPrivateKey } from "../../services/portal-api/src/keys";
import { migrateFoundation, rollbackFoundation } from "../../services/portal-api/src/migrate";
import { closePoll, openPoll } from "../../services/portal-api/src/poll-lifecycle";
import { RedeemError, redeemResponse } from "../../services/respond-api/src/redeem";
import { nodeRawSign } from "../fixtures/rsa";

const url = inject("testDatabaseUrl"), master = randomBytes(32), owner = randomUUID();
const observer = new Client({ connectionString: url }), portal = new Client({ connectionString: url });
const publics: Client[] = [];
let directory: string;
const ids = { choice: randomUUID(), a: randomUUID(), b: randomUUID(), rating: randomUUID(), text: randomUUID() };
const questions = [
  { id: ids.choice, type: "single_choice", prompt: "Pick", required: true, options: [{ id: ids.a, label: "A" }, { id: ids.b, label: "B" }] },
  { id: ids.rating, type: "rating", prompt: "Rate", required: false },
  { id: ids.text, type: "free_text", prompt: "Say", required: false },
];
const answers = (choice = ids.a, rating = 4) => [{ questionId: ids.choice, value: choice }, { questionId: ids.rating, value: rating }];

type Poll = { id: string; keyId: string; jwk: { kty: "RSA"; n: string; e: "AQAB" }; ref: string };
async function openedPoll(): Promise<Poll> {
  const { id } = await createDraft(portal, owner, { title: "Redeem", description: "",
    closesAt: new Date(Date.now() + 86_400_000).toISOString(), questions,
    eligibilityEmails: Array.from({ length: 10 }, (_, i) => `student${i}@iitgn.ac.in`) }, directory, master);
  await openPoll(portal, owner, id, 1);
  const key = (await observer.query("SELECT key_id, public_jwk, private_secret_ref FROM signing_keys WHERE poll_id=$1", [id])).rows[0];
  return { id, keyId: key.key_id, jwk: key.public_jwk, ref: key.private_secret_ref };
}
/** A browser-equivalent credential: prepare, blind, independent raw sign, finalize. */
async function mint(signer: Poll, messagePollId = signer.id, secret = randomBytes(32)) {
  const key = await importPollPublicKey(signer.jwk);
  const prepared = prepareMessage(encodeApplicationMessage(messagePollId, secret));
  const { blindedMessage, inverse } = await blindMessage(key, prepared);
  const der = await loadPrivateKey(directory, master, signer.ref);
  const blindSig = nodeRawSign(createPrivateKey({ key: der, format: "der", type: "pkcs8" }), blindedMessage);
  const signature = await finalizeSignature(key, prepared, blindSig, inverse);
  return { secret, credential: { version: 1, keyId: signer.keyId, keyVersion: 1,
    preparedMessage: Buffer.from(prepared).toString("base64url"), signature: Buffer.from(signature).toString("base64url") } };
}
const nullifierOf = (pollId: string, secret: Buffer) => createHash("sha256").update(Buffer.concat([
  Buffer.from("IITGN-FEEDBACK-SPENT\0", "ascii"), Buffer.of(1), Buffer.from(pollId.replaceAll("-", ""), "hex"), secret])).digest();
const lockKeyOf = (pollId: string, nullifier: Buffer) => createHash("sha256").update(Buffer.concat([
  Buffer.from("IITGN-FEEDBACK-REDEEM-LOCK\0", "ascii"), Buffer.from(pollId.replaceAll("-", ""), "hex"), nullifier])).digest().readBigInt64BE(0);
async function publicClient(): Promise<Client> {
  const client = new Client({ connectionString: url });
  client.on("error", () => {});
  await client.connect();
  await client.query("SET ROLE feedback_response_public");
  publics.push(client);
  return client;
}
const outcome = (promise: Promise<{ status: number }>) => promise.then(
  (result) => result.status,
  (error) => (error instanceof RedeemError ? error.code + (error.field ? `:${error.field}` : "") : `unexpected: ${(error as Error).message}`),
);
const rows = async (pollId: string) =>
  (await observer.query("SELECT * FROM anonymous.responses WHERE poll_id=$1", [pollId])).rows;

beforeAll(async () => {
  await migrateFoundation(url);
  directory = await mkdtemp(join(tmpdir(), "feedback-redeem-"));
  await observer.connect();
  await portal.connect();
  await observer.query(`INSERT INTO identity.users(id,issuer,subject,email,is_organiser)
    VALUES($1,'https://accounts.google.com','redeem-owner','owner@iitgn.ac.in',true)`, [owner]);
  await portal.query("SET ROLE feedback_portal_admin");
});
afterAll(async () => {
  await Promise.allSettled(publics.map((client) => client.end()));
  await observer.end();
  await portal.end();
  await rollbackFoundation(url);
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("one valid credential stores exactly one canonical row; an identical retry confirms it, also after closure", async () => {
  const poll = await openedPoll();
  const client = await publicClient();
  const { credential, secret } = await mint(poll);
  const body = { credential, answers: [...answers(), { questionId: ids.text, value: " Fine\r\n" }] };
  expect(await outcome(redeemResponse(client, poll.id, body))).toBe(201);
  const stored = await rows(poll.id);
  expect(stored).toEqual([{ poll_id: poll.id, nullifier: nullifierOf(poll.id, secret),
    answers: [{ questionId: ids.choice, value: ids.a }, { questionId: ids.rating, value: 4 }, { questionId: ids.text, value: "Fine" }] }]);
  // Same canonical answers in another order and spelling: confirmed, not re-inserted.
  const reordered = { credential, answers: [{ questionId: ids.text, value: "Fine" }, ...answers().reverse()] };
  expect(await outcome(redeemResponse(client, poll.id, reordered))).toBe(200);
  expect(await outcome(redeemResponse(client, poll.id, { credential, answers: answers(ids.b) }))).toBe("credential_spent");
  expect(await rows(poll.id)).toEqual(stored);
  await closePoll(portal, owner, poll.id);
  expect(await outcome(redeemResponse(client, poll.id, reordered))).toBe(200);
  expect(await outcome(redeemResponse(client, poll.id, { credential, answers: answers(ids.b) }))).toBe("credential_spent");
  expect(await outcome(redeemResponse(client, poll.id, { credential: (await mint(poll)).credential, answers: answers() })))
    .toBe("poll_closed");
  await observer.query("UPDATE polls SET invalidated=true WHERE id=$1", [poll.id]);
  expect(await outcome(redeemResponse(client, poll.id, reordered))).toBe("poll_withdrawn");
  expect(await rows(poll.id)).toEqual(stored);
});

test("another preparation and signature of the same secret has the same nullifier and cannot add a response", async () => {
  const poll = await openedPoll();
  const client = await publicClient();
  const secret = randomBytes(32);
  const first = await mint(poll, poll.id, secret), second = await mint(poll, poll.id, secret);
  expect(second.credential.preparedMessage).not.toBe(first.credential.preparedMessage);
  expect(await outcome(redeemResponse(client, poll.id, { credential: first.credential, answers: answers() }))).toBe(201);
  expect(await outcome(redeemResponse(client, poll.id, { credential: second.credential, answers: answers() }))).toBe(200);
  expect(await outcome(redeemResponse(client, poll.id, { credential: second.credential, answers: answers(ids.b) }))).toBe("credential_spent");
  expect(await rows(poll.id)).toHaveLength(1);
});

test("parallel identical submissions insert one row; parallel different answers insert one row and conflict", async () => {
  for (const different of [false, true]) {
    const poll = await openedPoll();
    const clients = await Promise.all(Array.from({ length: 6 }, () => publicClient()));
    const { credential } = await mint(poll);
    const results = await Promise.all(clients.map((client, i) =>
      outcome(redeemResponse(client, poll.id, { credential, answers: answers(ids.a, different ? i % 5 + 1 : 3) }))));
    expect(results.filter((result) => result === 201)).toHaveLength(1);
    if (different) {
      // i % 5 + 1 repeats rating 1 for i = 0 and i = 5; whichever wins, its twin confirms.
      expect(results.every((result) => result === 201 || result === 200 || result === "credential_spent")).toBe(true);
      expect(results.filter((result) => result === "credential_spent").length).toBeGreaterThanOrEqual(4);
    } else {
      expect(results.filter((result) => result === 200)).toHaveLength(5);
    }
    expect(await rows(poll.id)).toHaveLength(1);
  }
});

test("bad credentials, framing and answers never create a row, and a validation failure does not spend the credential", async () => {
  const poll = await openedPoll(), other = await openedPoll();
  const client = await publicClient();
  const { credential } = await mint(poll);
  const flip = (text: string) => { const bytes = Buffer.from(text, "base64url"); bytes[200] ^= 1; return bytes.toString("base64url"); };
  // A client eligible only for `poll` blinds a hidden message naming `other`, and has `poll` sign it.
  const hidden = (await mint(poll, other.id)).credential;
  const cases: [string, unknown, string][] = [
    [poll.id, { credential: { ...credential, signature: flip(credential.signature) }, answers: answers() }, "invalid_credential"],
    [poll.id, { credential: { ...credential, keyId: other.keyId }, answers: answers() }, "invalid_credential"],
    [poll.id, { credential: { ...credential, keyVersion: 2 }, answers: answers() }, "invalid_credential"],
    [other.id, { credential, answers: answers() }, "invalid_credential"],
    [other.id, { credential: hidden, answers: answers() }, "invalid_credential"],
    [other.id, { credential: { ...hidden, keyId: other.keyId }, answers: answers() }, "invalid_credential"],
    [poll.id, { credential: hidden, answers: answers() }, "invalid_credential"], // signature valid, poll ID in grammar wrong
    [poll.id, { credential: { ...credential, version: 2 }, answers: answers() }, "invalid_request"],
    [poll.id, { credential: { ...credential, extra: 1 }, answers: answers() }, "invalid_request"],
    [poll.id, { credential: { ...credential, signature: `${credential.signature}=` }, answers: answers() }, "invalid_request"],
    [poll.id, { credential: { ...credential, preparedMessage: Buffer.alloc(110).toString("base64url") }, answers: answers() }, "invalid_request"],
    [poll.id, { credential, answers: answers(), extra: true }, "invalid_request"],
    [poll.id, { credential }, "invalid_request"],
    [poll.id, null, "invalid_request"],
    [poll.id, { credential, answers: [{ questionId: ids.rating, value: 4 }] }, "validation_failed:answers"],
    [poll.id, { credential, answers: [{ questionId: ids.choice, value: ids.a }, { questionId: ids.rating, value: "4" }] }, "validation_failed:answers[1].value"],
    [randomUUID(), { credential, answers: answers() }, "not_found"],
    ["not-a-uuid", { credential, answers: answers() }, "not_found"],
  ];
  for (const [pollId, body, expected] of cases) {
    expect([pollId === poll.id ? "poll" : "other", await outcome(redeemResponse(client, pollId, body))])
      .toEqual([pollId === poll.id ? "poll" : "other", expected]);
  }
  expect(await rows(poll.id)).toEqual([]);
  expect(await rows(other.id)).toEqual([]);
  expect(await outcome(redeemResponse(client, poll.id, { credential, answers: answers() }))).toBe(201);
});

test("a first submission waiting behind closure is refused; a retry past the deadline waits for the earlier acceptance", async () => {
  // (a) Closure or withdrawal in progress: the waiting submission sees the change under its lock.
  for (const [change, expected] of [
    ["UPDATE polls SET state='closed', closed_at=clock_timestamp() WHERE id=$1", "poll_closed"],
    ["UPDATE polls SET invalidated=true WHERE id=$1", "poll_withdrawn"],
  ] as const) {
    const closing = await openedPoll();
    const waiter = await publicClient(), holder = new Client({ connectionString: url });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM polls WHERE id=$1 FOR UPDATE", [closing.id]);
      const pending = outcome(redeemResponse(waiter, closing.id, { credential: (await mint(closing)).credential, answers: answers() }));
      const pid = (await waiter.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await expect.poll(async () => (await observer.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.wait_event_type).toBe("Lock");
      await holder.query(change, [closing.id]);
      await holder.query("COMMIT");
      expect(await pending).toBe(expected);
      expect(await rows(closing.id)).toEqual([]);
    } finally { await holder.end(); }
  }

  // (b) An insertion admitted before the deadline is still uncommitted when a retry arrives after it.
  const tight = await openedPoll();
  await observer.query("SET session_replication_role = replica");
  await observer.query("UPDATE polls SET closes_at=clock_timestamp() + interval '1500 milliseconds' WHERE id=$1", [tight.id]);
  await observer.query("SET session_replication_role = origin");
  const { credential, secret } = await mint(tight);
  const canonical = [{ questionId: ids.choice, value: ids.a }, { questionId: ids.rating, value: 4 }];
  const first = new Client({ connectionString: url });
  await first.connect();
  try {
    await first.query("SET ROLE feedback_response_public");
    await first.query("BEGIN");
    const admitted = await first.query("SELECT anonymous.redeem($1,$2,$3::jsonb) AS outcome",
      [tight.id, nullifierOf(tight.id, secret), JSON.stringify(canonical)]);
    expect(admitted.rows[0].outcome).toBe("inserted");
    // The redemption advisory lock uses the spec's key derivation.
    const lockKey = lockKeyOf(tight.id, nullifierOf(tight.id, secret));
    const held = (await observer.query(`SELECT ((classid::bigint << 32) | objid::bigint)::bigint AS key FROM pg_locks
      WHERE locktype='advisory' AND objsubid=1 AND granted`)).rows.map((row) => BigInt(row.key));
    expect(held.map((key) => BigInt.asIntN(64, key))).toContain(lockKey);
    await expect.poll(async () => (await observer.query("SELECT clock_timestamp() >= closes_at AS past FROM polls WHERE id=$1",
      [tight.id])).rows[0].past, { timeout: 5000 }).toBe(true);
    const retryClient = await publicClient();
    const retryPid = (await retryClient.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const retry = outcome(redeemResponse(retryClient, tight.id, { credential, answers: answers() }));
    await expect.poll(async () => (await observer.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [retryPid])).rows[0]?.wait_event_type).toBe("Lock");
    await first.query("COMMIT");
    expect(await retry).toBe(200); // never a premature terminal "closed"
    expect(await rows(tight.id)).toHaveLength(1);
    // Stored state is still 'open' (no closer ran): a new credential is refused by the deadline alone.
    expect((await observer.query("SELECT state FROM polls WHERE id=$1", [tight.id])).rows[0].state).toBe("open");
    expect(await outcome(redeemResponse(retryClient, tight.id, { credential: (await mint(tight)).credential, answers: answers() })))
      .toBe("poll_closed");
    expect(await rows(tight.id)).toHaveLength(1);
  } finally { await first.end(); }
});

test("a lost acknowledgement after a committed insert is retryable, and the retry confirms the one stored response", async () => {
  const poll = await openedPoll();
  const { credential } = await mint(poll);
  const real = await publicClient();
  const lostAck = new Proxy(real, { get(target, property, receiver) {
    if (property !== "query") return Reflect.get(target, property, receiver);
    return async (text: unknown, ...rest: unknown[]) => {
      const result = await Reflect.apply(target.query, target, [text, ...rest]);
      if (typeof text === "string" && /^\s*COMMIT\b/i.test(text)) throw new Error("Connection terminated unexpectedly");
      return result;
    };
  } });
  expect(await outcome(redeemResponse(lostAck, poll.id, { credential, answers: answers() }))).toBe("temporarily_unavailable");
  expect(await rows(poll.id)).toHaveLength(1);
  expect(await outcome(redeemResponse(await publicClient(), poll.id, { credential, answers: answers() }))).toBe(200);
  expect(await rows(poll.id)).toHaveLength(1);
});

test("the public role can redeem but cannot read responses, identities or private-key references", async () => {
  const client = await publicClient();
  for (const sql of ["SELECT * FROM anonymous.responses", "SELECT * FROM identity.users", "SELECT * FROM identity.claims",
    "SELECT private_secret_ref FROM signing_keys", "INSERT INTO anonymous.responses VALUES (gen_random_uuid(), '\\x00', '[]')"]) {
    await expect(client.query(sql)).rejects.toMatchObject({ code: "42501" });
  }
  const columns = (await observer.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema='anonymous' AND table_name='responses' ORDER BY column_name`)).rows.map((row) => row.column_name);
  expect(columns).toEqual(["answers", "nullifier", "poll_id"]); // no timestamp, request, identity or sequence column
});
