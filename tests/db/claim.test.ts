// Milestone 3 issuance service against real PostgreSQL. The signer double is an
// independent OpenSSL raw private operation (native signing itself is proven in
// tests/signer); these tests cover claim-before-sign ordering and uniqueness.
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
import { ClaimError, issueClaim, type ClaimDependencies } from "../../services/portal-api/src/claim";
import { createDraft } from "../../services/portal-api/src/create-draft";
import { loadPrivateKey } from "../../services/portal-api/src/keys";
import { migrateFoundation, rollbackFoundation } from "../../services/portal-api/src/migrate";
import { closePoll, openPoll } from "../../services/portal-api/src/poll-lifecycle";
import { nodeRawSign } from "../fixtures/rsa";

const url = inject("testDatabaseUrl"), master = randomBytes(32);
const observer = new Client({ connectionString: url }), portal = new Client({ connectionString: url });
const issuers: Client[] = [];
let directory: string;
const users = {
  owner: randomUUID(), alice: randomUUID(), bob: randomUUID(), carol: randomUUID(), twin: randomUUID(),
  renamer: randomUUID(), reassignee: randomUUID(), sixth: randomUUID(),
};
const emails: Record<keyof typeof users, string> = {
  owner: "owner@iitgn.ac.in", alice: "student0@iitgn.ac.in", bob: "student1@iitgn.ac.in",
  carol: "unlisted@iitgn.ac.in", twin: "student0@iitgn.ac.in", renamer: "student5@iitgn.ac.in",
  reassignee: "student5@iitgn.ac.in", sixth: "student6@iitgn.ac.in",
};
const session = (name: keyof typeof users) => ({ id: users[name], email: emails[name] });

type Poll = { id: string; keyId: string; publicJwk: { kty: "RSA"; n: string; e: "AQAB" } };
async function openedPoll(): Promise<Poll> {
  const { id } = await createDraft(portal, users.owner, {
    title: "Claim test", description: "", closesAt: new Date(Date.now() + 86400000).toISOString(),
    questions: [{ id: randomUUID(), type: "rating", prompt: "Score?", required: true }],
    eligibilityEmails: Array.from({ length: 10 }, (_, i) => `student${i}@iitgn.ac.in`),
  }, directory, master);
  await openPoll(portal, users.owner, id, 1);
  const key = (await observer.query("SELECT key_id, public_jwk FROM signing_keys WHERE poll_id=$1", [id])).rows[0];
  return { id, keyId: key.key_id, publicJwk: key.public_jwk };
}
async function issuer(): Promise<Client> {
  const client = new Client({ connectionString: url });
  client.on("error", () => {}); // terminated-backend tests surface errors via the query instead
  await client.connect();
  await client.query("SET ROLE feedback_issuer");
  issuers.push(client);
  return client;
}
async function request(poll: Poll, publicJwk = poll.publicJwk) {
  const key = await importPollPublicKey(publicJwk);
  const prepared = prepareMessage(encodeApplicationMessage(poll.id, randomBytes(32)));
  const { blindedMessage, inverse } = await blindMessage(key, prepared);
  return { key, prepared, inverse, blinded: blindedMessage,
    body: { keyId: poll.keyId, keyVersion: 1, blindedMessage: Buffer.from(blindedMessage).toString("base64url") } };
}
const rawSign = (der: Buffer, blinded: Uint8Array) =>
  nodeRawSign(createPrivateKey({ key: der, format: "der", type: "pkcs8" }), blinded);
function dependencies(overrides: Partial<ClaimDependencies> = {}) {
  const calls = { reserve: 0, release: 0, load: 0, sign: 0, loaded: [] as Buffer[] };
  const deps: ClaimDependencies = {
    reserve: async () => { calls.reserve++; return () => { calls.release++; }; },
    loadKey: async (ref) => {
      calls.load++;
      const key = await loadPrivateKey(directory, master, ref);
      calls.loaded.push(key);
      return key;
    },
    sign: async (key, blinded) => { calls.sign++; return rawSign(key, blinded); },
    ...overrides,
  };
  return { calls, deps };
}
const claimRows = async (pollId: string) =>
  (await observer.query("SELECT * FROM identity.claims WHERE poll_id=$1 ORDER BY user_id", [pollId])).rows;
const code = (promise: Promise<unknown>) => promise.then(
  () => "fulfilled",
  (error) => (error instanceof ClaimError ? error.code : `unexpected: ${(error as Error).message}`),
);

beforeAll(async () => {
  await migrateFoundation(url);
  directory = await mkdtemp(join(tmpdir(), "feedback-claim-"));
  await observer.connect();
  await portal.connect();
  for (const [name, id] of Object.entries(users)) {
    await observer.query(`INSERT INTO identity.users(id,issuer,subject,email,is_organiser)
      VALUES($1,'https://accounts.google.com',$2,$3,$4)`, [id, `claim-${name}`, emails[name as keyof typeof users], name === "owner"]);
  }
  await portal.query("SET ROLE feedback_portal_admin");
});
afterAll(async () => {
  await Promise.allSettled(issuers.map((client) => client.end()));
  await observer.end();
  await portal.end();
  await rollbackFoundation(url);
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("one eligible account gets one signature, released only after its claim commits, verifying only under this poll's key", async () => {
  const poll = await openedPoll(), other = await openedPoll();
  const client = await issuer();
  const visibleAtSign: unknown[][] = [];
  const { calls, deps } = dependencies({
    sign: async (key, blinded) => {
      calls.sign++;
      // A separate connection sees the claim only once it has committed.
      visibleAtSign.push(await claimRows(poll.id));
      return rawSign(key, blinded);
    },
  });
  const attempt = await request(poll);
  const result = await issueClaim(client, session("alice"), poll.id, attempt.body, deps);
  expect(Object.keys(result)).toEqual(["blindSignature"]);
  const eligibility = (await observer.query(
    "SELECT id FROM identity.eligibility WHERE poll_id=$1 AND email=$2", [poll.id, emails.alice])).rows[0].id;
  const row = { poll_id: poll.id, user_id: users.alice, eligibility_id: eligibility };
  expect(visibleAtSign).toEqual([[row]]);
  // Claim rows hold no blinded request, signature, timestamp or response reference.
  expect(await claimRows(poll.id)).toEqual([row]);
  const signature = await finalizeSignature(attempt.key, attempt.prepared,
    Buffer.from(result.blindSignature, "base64url"), attempt.inverse);
  expect(await verifySignature(attempt.key, attempt.prepared, signature)).toBe(true);
  expect(await verifySignature(await importPollPublicKey(other.publicJwk), attempt.prepared, signature)).toBe(false);
  expect(calls).toMatchObject({ reserve: 1, release: 1, load: 1, sign: 1 });
  expect(calls.loaded[0].every((byte) => byte === 0)).toBe(true); // private key buffer is wiped after use

  expect(await code(issueClaim(client, session("alice"), poll.id, (await request(poll)).body, deps))).toBe("claim_consumed");
  expect(calls.sign).toBe(1);
  expect(calls.release).toBe(calls.reserve);
  expect(await claimRows(poll.id)).toHaveLength(1);
});

test("a request blinded for poll B but sent to poll A never yields a credential for B", async () => {
  const pollA = await openedPoll(), pollB = await openedPoll();
  const client = await issuer();
  const { calls, deps } = dependencies();
  const nA = Buffer.from(pollA.publicJwk.n, "base64url");
  let crossed;
  // Blinding under n_B may give a value >= n_A, which the issuer correctly refuses; re-blind.
  for (let tries = 0; tries < 64 && !crossed; tries++) {
    const candidate = await request(pollB);
    if (Buffer.compare(Buffer.from(candidate.blinded), nA) < 0) crossed = candidate;
  }
  expect(crossed).toBeDefined();
  const result = await issueClaim(client, session("bob"), pollA.id, { ...crossed!.body, keyId: pollA.keyId }, deps);
  await expect(finalizeSignature(crossed!.key, crossed!.prepared,
    Buffer.from(result.blindSignature, "base64url"), crossed!.inverse)).rejects.toThrow();
  expect(calls.sign).toBe(1);
  // B's own entitlement is untouched, and B's key ID is not accepted for A.
  expect(await claimRows(pollB.id)).toEqual([]);
  expect(await code(issueClaim(client, session("alice"), pollA.id, (await request(pollB)).body, deps))).toBe("invalid_request");
});

test("framing, range, key, and poll-state rejections consume nothing and load no key or signer capacity", async () => {
  const poll = await openedPoll(), other = await openedPoll();
  const client = await issuer();
  const { calls, deps } = dependencies();
  const good = (await request(poll)).body;
  const n = Buffer.from(poll.publicJwk.n, "base64url");
  const bytes = (value: Buffer) => value.toString("base64url");
  const malformed: unknown[] = [
    null, [], "x", {}, { keyId: poll.keyId, keyVersion: 1 },
    { ...good, extra: true }, { ...good, keyVersion: 2 }, { ...good, keyVersion: "1" },
    { ...good, keyId: poll.keyId.toUpperCase() }, { ...good, keyId: other.keyId },
    { ...good, blindedMessage: `${good.blindedMessage}=` }, { ...good, blindedMessage: bytes(randomBytes(383)) },
    { ...good, blindedMessage: bytes(randomBytes(385)) }, { ...good, blindedMessage: good.blindedMessage.replace(/^./, "+") },
    { ...good, blindedMessage: bytes(Buffer.alloc(384)) }, // m = 0
    { ...good, blindedMessage: bytes(n) }, // m = n
    { ...good, blindedMessage: bytes(Buffer.alloc(384, 0xff)) }, // m > n
  ];
  for (const body of malformed) {
    expect(await code(issueClaim(client, session("alice"), poll.id, body, deps))).toBe("invalid_request");
  }

  const { id: draftId } = await createDraft(portal, users.owner, {
    title: "Still a draft", description: "", closesAt: new Date(Date.now() + 86400000).toISOString(),
    questions: [{ id: randomUUID(), type: "rating", prompt: "Score?", required: true }],
    eligibilityEmails: Array.from({ length: 10 }, (_, i) => `student${i}@iitgn.ac.in`),
  }, directory, master);
  const draftKey = (await observer.query("SELECT key_id FROM signing_keys WHERE poll_id=$1", [draftId])).rows[0].key_id;
  const closed = await openedPoll(); await closePoll(portal, users.owner, closed.id);
  const expired = await openedPoll();
  await observer.query("SET session_replication_role = replica"); // bypass freeze trigger for the fixture only
  await observer.query("UPDATE polls SET closes_at=clock_timestamp()-interval '1 second' WHERE id=$1", [expired.id]);
  await observer.query("SET session_replication_role = origin");
  const withdrawnOpen = await openedPoll();
  await observer.query("UPDATE polls SET invalidated=true WHERE id=$1", [withdrawnOpen.id]);
  const withdrawnClosed = await openedPoll(); await closePoll(portal, users.owner, withdrawnClosed.id);
  await observer.query("UPDATE polls SET invalidated=true WHERE id=$1", [withdrawnClosed.id]);
  const cases: [string, unknown, string][] = [
    ["not-a-uuid", good, "not_found"],
    [randomUUID(), good, "not_found"],
    [draftId, { ...good, keyId: draftKey }, "not_found"],
    [closed.id, { ...good, keyId: closed.keyId }, "poll_closed"],
    [expired.id, { ...good, keyId: expired.keyId }, "poll_closed"],
    [withdrawnOpen.id, { ...good, keyId: withdrawnOpen.keyId }, "poll_withdrawn"],
    [withdrawnClosed.id, { ...good, keyId: withdrawnClosed.keyId }, "poll_withdrawn"],
  ];
  for (const [pollId, body, expected] of cases) {
    expect(await code(issueClaim(client, session("alice"), pollId, body, deps))).toBe(expected);
  }
  expect(calls).toMatchObject({ reserve: 0, load: 0, sign: 0 });
  const all = (await observer.query("SELECT count(*)::int AS count FROM identity.claims")).rows[0].count;

  // Capacity and key-load failures happen before the entitlement is touched.
  const busy = dependencies({ reserve: async () => { throw new ClaimError("capacity_unavailable"); } });
  expect(await code(issueClaim(client, session("alice"), poll.id, good, busy.deps))).toBe("capacity_unavailable");
  const lost = dependencies({ loadKey: async () => { throw new Error("key store unavailable"); } });
  expect(await code(issueClaim(client, session("alice"), poll.id, good, lost.deps))).toBe("capacity_unavailable");
  expect(lost.calls.release).toBe(lost.calls.reserve);
  // Not-eligible is decided under the poll lock; it consumes nothing and releases capacity.
  const ineligible = dependencies();
  expect(await code(issueClaim(client, session("carol"), poll.id, good, ineligible.deps))).toBe("not_eligible");
  expect(ineligible.calls).toMatchObject({ sign: 0, release: ineligible.calls.reserve });
  expect((await observer.query("SELECT count(*)::int AS count FROM identity.claims")).rows[0].count).toBe(all);
  // None of those attempts used up alice's entitlement.
  expect(await code(issueClaim(client, session("alice"), poll.id, good, deps))).toBe("fulfilled");
});

test("concurrent claims by one account, or by two accounts sharing one eligibility entry, yield exactly one signature", async () => {
  for (const contenders of [
    Array.from({ length: 8 }, () => session("alice")),
    [...Array.from({ length: 4 }, () => session("alice")), ...Array.from({ length: 4 }, () => session("twin"))],
  ]) {
    const poll = await openedPoll();
    const clients = await Promise.all(contenders.map(() => issuer()));
    const bodies = await Promise.all(contenders.map(async () => (await request(poll)).body));
    let arrived = 0, start!: () => void;
    const gate = new Promise<void>((resolve) => { start = resolve; });
    const { calls, deps } = dependencies({
      // Every attempt reserves capacity first, then all enter the claim transaction together.
      reserve: async () => {
        calls.reserve++;
        if (++arrived === contenders.length) start();
        await gate;
        return () => { calls.release++; };
      },
    });
    const outcomes = await Promise.all(contenders.map((who, i) => code(issueClaim(clients[i], who, poll.id, bodies[i], deps))));
    expect(outcomes.filter((outcome) => outcome === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "claim_consumed")).toHaveLength(contenders.length - 1);
    expect(calls).toMatchObject({ sign: 1, reserve: contenders.length, release: contenders.length });
    expect(await claimRows(poll.id)).toHaveLength(1);
  }
});

test("a renamed account or a reassigned address cannot obtain a second entitlement; a stale session email is not eligible", async () => {
  const poll = await openedPoll();
  const client = await issuer();
  const { calls, deps } = dependencies();
  expect(await code(issueClaim(client, session("renamer"), poll.id, (await request(poll)).body, deps))).toBe("fulfilled");
  // The same Google subject now has another listed address: the account entitlement is spent.
  await observer.query("UPDATE identity.users SET email='student6@iitgn.ac.in' WHERE id=$1", [users.renamer]);
  expect(await code(issueClaim(client, { id: users.renamer, email: "student6@iitgn.ac.in" }, poll.id,
    (await request(poll)).body, deps))).toBe("claim_consumed");
  // A new subject holding the old address cannot use the consumed eligibility entry.
  expect(await code(issueClaim(client, session("reassignee"), poll.id, (await request(poll)).body, deps))).toBe("claim_consumed");
  // A session whose verified email is no longer the account's current email is refused.
  const fresh = await openedPoll();
  expect(await code(issueClaim(client, { id: users.renamer, email: "student5@iitgn.ac.in" }, fresh.id,
    (await request(fresh)).body, deps))).toBe("not_eligible");
  // The failed attempts did not consume student6's entry.
  expect(await code(issueClaim(client, session("sixth"), poll.id, (await request(poll)).body, deps))).toBe("fulfilled");
  expect(calls.sign).toBe(2);
  expect((await claimRows(poll.id)).map((row) => row.user_id).sort()).toEqual([users.renamer, users.sixth].sort());
  expect(await claimRows(fresh.id)).toEqual([]);
});

test("a claim waiting behind closure, deadline expiry, or withdrawal sees the change under the lock and consumes nothing", async () => {
  const changes: [string, string][] = [
    ["UPDATE polls SET state='closed', closed_at=LEAST(closes_at, clock_timestamp()) WHERE id=$1", "poll_closed"],
    ["UPDATE polls SET closes_at=clock_timestamp() WHERE id=$1", "poll_closed"], // stored state stays 'open'
    ["UPDATE polls SET invalidated=true WHERE id=$1", "poll_withdrawn"],
  ];
  for (const [change, expected] of changes) {
    const poll = await openedPoll();
    const client = await issuer();
    const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const holder = new Client({ connectionString: url });
    await holder.connect();
    try {
      // The holder plays an in-progress closer: it owns the conflicting poll row lock.
      await holder.query("BEGIN");
      await holder.query("SET LOCAL session_replication_role = replica"); // fixture bypasses the freeze trigger
      await holder.query("SELECT 1 FROM polls WHERE id=$1 FOR UPDATE", [poll.id]);
      const { calls, deps } = dependencies();
      let settled = false;
      const outcome = code(issueClaim(client, session("alice"), poll.id, (await request(poll)).body, deps))
        .finally(() => { settled = true; });
      for (let polls = 0; polls < 250 && !settled; polls++) {
        const wait = (await observer.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0];
        if (wait?.wait_event_type === "Lock") break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(settled).toBe(false); // the claim must be blocked on the poll lock, not already decided
      await holder.query(change, [poll.id]);
      await holder.query("COMMIT");
      expect(await outcome).toBe(expected);
      expect(calls.sign).toBe(0);
      expect(calls.release).toBe(calls.reserve);
      expect(await claimRows(poll.id)).toEqual([]);
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      await holder.end();
    }
  }
});

test("an uncertain commit never signs, and the database decides whether the entitlement was consumed", async () => {
  const committedPoll = await openedPoll(), abortedPoll = await openedPoll();
  const { calls, deps } = dependencies();
  // (a) The commit reaches the server but its acknowledgement is lost.
  const acked = await issuer();
  const lostAck = new Proxy(acked, { get(target, property, receiver) {
    if (property !== "query") return Reflect.get(target, property, receiver);
    return async (text: unknown, ...rest: unknown[]) => {
      const result = await Reflect.apply(target.query, target, [text, ...rest]);
      if (typeof text === "string" && /^\s*COMMIT\b/i.test(text)) throw new Error("Connection terminated unexpectedly");
      return result;
    };
  } });
  expect(await code(issueClaim(lostAck, session("alice"), committedPoll.id, (await request(committedPoll)).body, deps)))
    .toBe("temporarily_unavailable");
  expect(calls.sign).toBe(0);
  expect(await claimRows(committedPoll.id)).toHaveLength(1);
  expect(await code(issueClaim(await issuer(), session("alice"), committedPoll.id, (await request(committedPoll)).body, deps)))
    .toBe("claim_consumed");

  // (b) The backend dies before the commit: nothing was consumed, but the issuer cannot know.
  const doomed = await issuer();
  const pid = (await doomed.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  const killed = new Proxy(doomed, { get(target, property, receiver) {
    if (property !== "query") return Reflect.get(target, property, receiver);
    return async (text: unknown, ...rest: unknown[]) => {
      if (typeof text === "string" && /^\s*COMMIT\b/i.test(text)) {
        await observer.query("SELECT pg_terminate_backend($1, 5000)", [pid]); // waits for exit
      }
      return Reflect.apply(target.query, target, [text, ...rest]);
    };
  } });
  expect(await code(issueClaim(killed, session("alice"), abortedPoll.id, (await request(abortedPoll)).body, deps)))
    .toBe("temporarily_unavailable");
  expect(calls.sign).toBe(0);
  expect(await claimRows(abortedPoll.id)).toEqual([]);
  expect(await code(issueClaim(await issuer(), session("alice"), abortedPoll.id, (await request(abortedPoll)).body, deps)))
    .toBe("fulfilled");
  expect(calls.release).toBe(calls.reserve);
});

test("after a committed claim, a failed or faulty signature is withheld and reported as consumed without credential", async () => {
  const poll = await openedPoll(), wrongKeyPoll = await openedPoll();
  const client = await issuer();
  const failing = dependencies({ sign: async () => { throw new Error("signer unavailable"); } });
  expect(await code(issueClaim(client, session("alice"), poll.id, (await request(poll)).body, failing.deps)))
    .toBe("claim_consumed_no_credential");
  expect(failing.calls.release).toBe(1);
  expect(failing.calls.loaded[0].every((byte) => byte === 0)).toBe(true);
  expect(await claimRows(poll.id)).toHaveLength(1);

  // A signer that answers with another poll's key fails the issuer's public-operation check.
  const wrongRef = (await observer.query("SELECT private_secret_ref FROM signing_keys WHERE poll_id=$1",
    [wrongKeyPoll.id])).rows[0].private_secret_ref;
  const wrongKey = await loadPrivateKey(directory, master, wrongRef);
  const n = Buffer.from(poll.publicJwk.n, "base64url"), nWrong = Buffer.from(wrongKeyPoll.publicJwk.n, "base64url");
  let attempt;
  for (let tries = 0; tries < 64 && !attempt; tries++) {
    const candidate = await request(poll);
    if (Buffer.compare(Buffer.from(candidate.blinded), nWrong) < 0) attempt = candidate;
  }
  expect(attempt).toBeDefined();
  expect(Buffer.compare(n, nWrong)).not.toBe(0);
  const faulty = dependencies({ sign: async (_key, blinded) => rawSign(wrongKey, blinded) });
  expect(await code(issueClaim(client, session("bob"), poll.id, attempt!.body, faulty.deps)))
    .toBe("claim_consumed_no_credential");
  expect(await claimRows(poll.id)).toHaveLength(2);
  expect(await code(issueClaim(client, session("bob"), poll.id, (await request(poll)).body, faulty.deps)))
    .toBe("claim_consumed");
});
