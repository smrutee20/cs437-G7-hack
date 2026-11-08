// SPEC.md §15 retention, withdrawal and recovery against real PostgreSQL
// (scenarios 23, 25, 26). Clock boundaries are reached by moving fixture
// timestamps back with triggers disabled (superuser fixture setup only); every
// production path runs under its own restricted role.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, expect, inject, test } from "vitest";
import { createApp } from "../../services/portal-api/src/index";
import { createDraft } from "../../services/portal-api/src/create-draft";
import { deleteDraft } from "../../services/portal-api/src/delete-draft";
import { assertJournalInSync, journaled, readJournal } from "../../services/portal-api/src/journal";
import { loadPrivateKey } from "../../services/portal-api/src/keys";
import { migrateFoundation, rollbackFoundation } from "../../services/portal-api/src/migrate";
import {
  findMissingKeys, recoverDeployment, runRetention, setOrganiser, withdrawPoll,
} from "../../services/portal-api/src/operations";
import { closePoll, openPoll, PollError } from "../../services/portal-api/src/poll-lifecycle";
import { readResults } from "../../services/portal-api/src/results";
import { redeemResponse } from "../../services/respond-api/src/redeem";
import { mintCredential } from "../fixtures/mint";

const url = inject("testDatabaseUrl"), master = randomBytes(32), owner = randomUUID();
const origin = "https://portal.feedback.test:4173";
let keys: string, journalDir: string, journal: string;
const clients: Record<string, Client> = {};
const roles = { observer: null, portal: "feedback_portal_admin", publicDb: "feedback_response_public",
  issuer: "feedback_issuer", retention: "feedback_retention", operator: "feedback_operator" } as const;
type Name = keyof typeof roles;
const db = (name: Name) => clients[name];

async function connectAll(target = url) {
  for (const [name, role] of Object.entries(roles)) {
    const client = new Client({ connectionString: target });
    await client.connect();
    if (role) await client.query(`SET ROLE ${role}`);
    clients[name] = client;
  }
}
const endAll = async () => { for (const client of Object.values(clients)) await client.end(); };
const rating = { id: randomUUID(), type: "rating", prompt: "Rate", required: true };
const eligible = Array.from({ length: 10 }, (_, i) => `member${i}@iitgn.ac.in`);

async function draft(title = "Ops poll") {
  const { id } = await createDraft(db("portal"), owner, { title, description: "",
    closesAt: new Date(Date.now() + 86_400_000).toISOString(), questions: [rating], eligibilityEmails: eligible }, keys, master);
  return id;
}
async function opened(responses = 0) {
  const id = await draft();
  await openPoll(db("portal"), owner, id, 1);
  const key = (await db("observer").query("SELECT key_id, public_jwk, private_secret_ref FROM signing_keys WHERE poll_id=$1", [id])).rows[0];
  const der = await loadPrivateKey(keys, master, key.private_secret_ref);
  const signer = { keyId: key.key_id as string, jwk: key.public_jwk, der };
  const submitted: { credential: unknown; answers: unknown }[] = [];
  for (let i = 0; i < responses; i++) {
    const body = { credential: await mintCredential(signer, id), answers: [{ questionId: rating.id, value: 1 + (i % 5) }] };
    expect((await redeemResponse(db("publicDb"), id, body)).status).toBe(201);
    submitted.push(body);
  }
  return { id, keyId: signer.keyId, signer, submitted };
}
async function participant(email: string) {
  const id = randomUUID();
  await db("observer").query(`INSERT INTO identity.users(id,issuer,subject,email) VALUES($1,'https://accounts.google.com',$2,$3)`,
    [id, `ops-${id}`, email]);
  return id;
}
const claim = async (pollId: string, userId: string, email: string, keyId: string) =>
  (await db("issuer").query("SELECT identity.claim_entitlement($1,$2,$3,$4) AS outcome", [pollId, userId, email, keyId])).rows[0].outcome;
/** Fixture-only time travel: moves a poll's lifecycle timestamps back with triggers disabled. */
async function age(pollId: string, interval: string) {
  const o = db("observer");
  await o.query("SET session_replication_role = replica");
  try {
    await o.query(`UPDATE polls SET created_at=created_at-$2::interval, updated_at=updated_at-$2::interval,
      opened_at=opened_at-$2::interval, closes_at=closes_at-$2::interval, closed_at=closed_at-$2::interval WHERE id=$1`, [pollId, interval]);
  } finally { await o.query("SET session_replication_role = origin"); }
}
const count = async (sql: string, params: unknown[] = []) => Number((await db("observer").query(sql, params)).rows[0].count);
const ops = (name: Name) => ({ client: db(name), journalPath: journal, keyDirectory: keys });
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await migrateFoundation(url);
  keys = await mkdtemp(join(tmpdir(), "feedback-ops-keys-"));
  journalDir = await mkdtemp(join(tmpdir(), "feedback-ops-journal-"));
  journal = join(journalDir, "journal.jsonl");
  await connectAll();
  await db("observer").query(`INSERT INTO identity.users(id,issuer,subject,email,is_organiser)
    VALUES($1,'https://accounts.google.com','ops-owner','ops.owner@iitgn.ac.in',true)`, [owner]);
  app = createApp({ origin, keyDirectory: keys, encryptionKey: master, cursorKey: randomBytes(32), journalPath: journal,
    authenticate: async () => ({ id: owner, email: "ops.owner@iitgn.ac.in", isOrganiser: true, csrfToken: "csrf" }),
    acquireClient: async () => {
      const client = new Client({ connectionString: url });
      await client.connect();
      await client.query("SET ROLE feedback_portal_admin");
      return { client, release: () => client.end() };
    } });
});
afterAll(async () => {
  await app?.close();
  await endAll();
  await rollbackFoundation(url);
  for (const dir of [keys, journalDir]) if (dir) await rm(dir, { recursive: true, force: true });
});
const ownerGet = (path: string) => app.inject({ method: "GET", url: `/api/v1${path}`, headers: { cookie: "__Host-session=x" } });

test("retention boundaries: 7-day identity purge, key destruction, 90-day content purge, drafts, users and tombstones", async () => {
  const closed = await opened(5), live = await opened(0);
  const leaver = await participant(eligible[0]), stayer = await participant(eligible[1]);
  expect(await claim(closed.id, leaver, eligible[0], closed.keyId)).toBe("claimed");
  expect(await claim(live.id, stayer, eligible[1], live.keyId)).toBe("claimed");
  await closePoll(db("portal"), owner, closed.id);
  expect((await readResults(db("portal"), owner, closed.id)).outcome).toBe("ready");
  const liveBefore = [await count("SELECT count(*) FROM identity.claims WHERE poll_id=$1", [live.id]),
    await count("SELECT count(*) FROM identity.eligibility WHERE poll_id=$1", [live.id])];

  // Closure alone: the private key is destroyed on the next run; public key and confirmations remain.
  await runRetention(ops("retention"));
  expect(await readdir(keys)).not.toContain(closed.keyId);
  expect((await db("observer").query("SELECT lifecycle, private_secret_ref, public_jwk FROM signing_keys WHERE poll_id=$1", [closed.id])).rows[0])
    .toMatchObject({ lifecycle: "destroyed", private_secret_ref: null, public_jwk: closed.signer.jwk });
  expect((await redeemResponse(db("publicDb"), closed.id, closed.submitted[0])).status).toBe(200);
  expect((await ownerGet(`/polls/${closed.id}`)).json()).toMatchObject({ eligibilityRetention: "retained", eligibleCount: 10 });

  // Seven days after closure: the owner DTO shows purged even before deletion runs.
  await age(closed.id, "7 days 1 minute");
  expect((await ownerGet(`/polls/${closed.id}`)).json()).toMatchObject({ eligibilityEmails: null, eligibilityRetention: "purged" });
  expect((await ownerGet("/polls")).json().items.find((p: { id: string }) => p.id === closed.id).eligibilityRetention).toBe("purged");
  await runRetention(ops("retention"));
  expect(await count("SELECT count(*) FROM identity.claims WHERE poll_id=$1", [closed.id])).toBe(0);
  expect(await count("SELECT count(*) FROM identity.eligibility WHERE poll_id=$1", [closed.id])).toBe(0);
  expect(await count("SELECT count(*) FROM identity.users WHERE id=$1", [leaver])).toBe(0); // nothing retained needs them
  expect(await count("SELECT count(*) FROM identity.users WHERE id=ANY($1::uuid[])", [[stayer, owner]])).toBe(2);
  expect([await count("SELECT count(*) FROM identity.claims WHERE poll_id=$1", [live.id]),
    await count("SELECT count(*) FROM identity.eligibility WHERE poll_id=$1", [live.id])]).toEqual(liveBefore);
  expect(await count("SELECT count(*) FROM anonymous.responses WHERE poll_id=$1", [closed.id])).toBe(5);

  // Ninety days: access ends at the boundary, then the purge leaves only a tombstone.
  await age(closed.id, "83 days");
  expect((await db("publicDb").query("SELECT id FROM public_polls WHERE id=$1", [closed.id])).rows).toEqual([]);
  expect((await ownerGet(`/polls/${closed.id}`)).statusCode).toBe(404);
  expect((await ownerGet("/polls")).json().items.map((p: { id: string }) => p.id)).not.toContain(closed.id);
  expect(await readResults(db("portal"), owner, closed.id)).toEqual({ outcome: "not_found" });
  await expect(redeemResponse(db("publicDb"), closed.id, closed.submitted[0])).rejects.toMatchObject({ code: "not_found" });
  const stale = await draft("Stale draft");
  const staleKey = (await db("observer").query("SELECT key_id FROM signing_keys WHERE poll_id=$1", [stale])).rows[0].key_id;
  await age(stale, "30 days 1 minute");
  const oldTombstone = randomUUID();
  await db("observer").query("INSERT INTO operations.purge_tombstones(poll_id,purged_at) VALUES($1, clock_timestamp()-interval '366 days')", [oldTombstone]);
  const result = await runRetention(ops("retention"));
  expect(result.purged).toBe(2);
  for (const table of ["polls WHERE id", "signing_keys WHERE poll_id", "anonymous.responses WHERE poll_id", "anonymous.result_snapshots WHERE poll_id"]) {
    expect(await count(`SELECT count(*) FROM ${table} = ANY($1::uuid[])`, [[closed.id, stale]]), table).toBe(0);
  }
  expect(await count("SELECT count(*) FROM operations.purge_tombstones WHERE poll_id = ANY($1::uuid[])", [[closed.id, stale]])).toBe(2);
  expect(await count("SELECT count(*) FROM operations.purge_tombstones WHERE poll_id=$1", [oldTombstone])).toBe(0);
  expect(await readdir(keys)).not.toContain(staleKey);
  const entries = (await readJournal(journal)).entries.map(({ kind, pollId, reason }) => ({ kind, pollId, reason }));
  expect(entries).toEqual(expect.arrayContaining([{ kind: "purge", pollId: closed.id, reason: "retention" },
    { kind: "purge", pollId: stale, reason: "draft_expired" }]));
  expect(JSON.stringify(await readFile(journal, "utf8"))).not.toMatch(/@iitgn|Rate|Ops poll|member/);
  await assertJournalInSync(db("portal"), journal);

  // Auth state: expired transactions and sessions go; live uniqueness state cannot be removed by request roles.
  await db("observer").query(`INSERT INTO identity.sessions(token_hash,user_id,email,csrf_token,expires_at)
    VALUES($1,$2,'x@iitgn.ac.in',$3,clock_timestamp()-interval '1 second')`, [randomBytes(32), stayer, randomBytes(32).toString("base64url")]);
  await db("observer").query(`INSERT INTO identity.oauth_transactions(state_hash,preauth_hash,nonce,pkce_verifier,return_path,expires_at)
    VALUES($1,$2,$3,$4,'/',clock_timestamp()-interval '1 second')`,
    [randomBytes(32), randomBytes(32), randomBytes(32).toString("base64url"), randomBytes(32).toString("base64url")]);
  await runRetention(ops("retention"));
  expect(await count("SELECT count(*) FROM identity.sessions")).toBe(0);
  expect(await count("SELECT count(*) FROM identity.oauth_transactions")).toBe(0);
  for (const [name, sql] of [["portal", "DELETE FROM identity.claims"], ["issuer", "DELETE FROM identity.claims"],
    ["publicDb", "DELETE FROM anonymous.responses"], ["retention", "DELETE FROM identity.claims"],
    ["portal", `DELETE FROM identity.eligibility WHERE poll_id='${live.id}'`]] as const) {
    await expect(db(name).query(sql), `${name}: ${sql}`).rejects.toMatchObject({ code: expect.stringMatching(/^(42501|23514)$/) });
  }
  // Even the table owner cannot remove a live poll's claims or truncate uniqueness state.
  await expect(db("observer").query("DELETE FROM identity.claims WHERE poll_id=$1", [live.id])).rejects.toMatchObject({ code: "42501" });
  for (const table of ["identity.claims", "anonymous.responses"]) {
    await expect(db("observer").query(`TRUNCATE ${table} CASCADE`)).rejects.toMatchObject({ code: "42501" });
  }
}, 120_000);

test("operator withdrawal is journaled, permanent, closes the poll, destroys its key and hides cached results", async () => {
  const live = await opened(5), finished = await opened(5);
  const person = await participant(eligible[2]);
  await closePoll(db("portal"), owner, finished.id);
  expect((await readResults(db("portal"), owner, finished.id)).outcome).toBe("ready");
  // Organisers have no withdrawal or provisioning route or privilege.
  await expect(db("portal").query("SELECT operations.withdraw_poll($1,'operator',1)", [live.id])).rejects.toMatchObject({ code: "42501" });
  await expect(db("portal").query("SELECT operations.set_organiser('https://accounts.google.com','x',true)")).rejects.toMatchObject({ code: "42501" });
  const before = (await readJournal(journal)).seq;
  expect(await withdrawPoll(ops("operator"), live.id, "key_compromise")).toBe("withdrawn");
  expect(await withdrawPoll(ops("operator"), finished.id, "privacy_incident")).toBe("withdrawn");
  const tail = (await readJournal(journal)).entries.slice(before).map(({ kind, pollId, reason }) => ({ kind, pollId, reason }));
  expect(tail).toEqual([{ kind: "withdraw", pollId: live.id, reason: "key_compromise" },
    { kind: "withdraw", pollId: finished.id, reason: "privacy_incident" }]);
  const row = (await db("observer").query("SELECT state, invalidated, invalidation_reason, closed_at FROM polls WHERE id=$1", [live.id])).rows[0];
  expect(row).toMatchObject({ state: "closed", invalidated: true, invalidation_reason: "key_compromise" });
  expect(row.closed_at).not.toBeNull();
  expect(await readdir(keys)).not.toContain(live.keyId);
  expect((await db("publicDb").query("SELECT invalidated FROM public_polls WHERE id=$1", [live.id])).rows).toEqual([{ invalidated: true }]);
  expect(await claim(live.id, person, eligible[2], live.keyId)).toBe("poll_withdrawn");
  await expect(redeemResponse(db("publicDb"), live.id, live.submitted[0])).rejects.toMatchObject({ code: "poll_withdrawn" });
  expect(await readResults(db("portal"), owner, live.id)).toEqual({ outcome: "poll_withdrawn" });
  expect(await readResults(db("portal"), owner, finished.id)).toEqual({ outcome: "poll_withdrawn" });
  await expect(db("observer").query("UPDATE polls SET invalidated=false WHERE id=$1", [live.id])).rejects.toMatchObject({ code: "23514" });
  await expect(db("observer").query("UPDATE polls SET invalidation_reason='operator' WHERE id=$1", [live.id])).rejects.toMatchObject({ code: "23514" });
  const bare = await draft(); // invalidated without a reason (as some fixtures do) is still permanent
  await db("observer").query("UPDATE polls SET invalidated=true WHERE id=$1", [bare]);
  await expect(db("observer").query("UPDATE polls SET invalidated=false WHERE id=$1", [bare])).rejects.toMatchObject({ code: "23514" });
  // A withdrawn draft can never open; provisioning is operator-only against a stable subject.
  const pending = await draft();
  await withdrawPoll(ops("operator"), pending, "key_loss");
  await expect(openPoll(db("portal"), owner, pending, 1)).rejects.toEqual(new PollError("invalid_state"));
  expect(await setOrganiser(db("operator"), `ops-${person}`, true)).toBe(true);
  expect(await count("SELECT count(*) FROM identity.users WHERE id=$1 AND is_organiser", [person])).toBe(1);
  expect(await setOrganiser(db("operator"), "no-such-subject", true)).toBe(false);
  await assertJournalInSync(db("operator"), journal);
}, 120_000);

test("a missing live key is detected and refuses opening; it is never regenerated", async () => {
  const live = await opened(0), pending = await draft();
  const pendingKey = (await db("observer").query("SELECT key_id FROM signing_keys WHERE poll_id=$1", [pending])).rows[0].key_id;
  await rm(join(keys, live.keyId)); await rm(join(keys, pendingKey));
  const missing = await findMissingKeys(ops("operator"));
  expect(missing).toEqual(expect.arrayContaining([{ pollId: live.id, state: "open" }, { pollId: pending, state: "draft" }]));
  const response = await app.inject({ method: "POST", url: `/api/v1/polls/${pending}/open`, payload: JSON.stringify({ revision: 1 }),
    headers: { cookie: "__Host-session=x", origin, "x-csrf-token": "csrf", "content-type": "application/json" } });
  expect(response.statusCode).toBe(422);
  expect((await db("observer").query("SELECT state FROM polls WHERE id=$1", [pending])).rows[0].state).toBe("draft");
  expect(await readdir(keys)).not.toContain(pendingKey);
  await withdrawPoll(ops("operator"), live.id, "key_loss");
  expect((await findMissingKeys(ops("operator"))).map((m) => m.pollId)).not.toContain(live.id);
}, 60_000);

test("an interrupted journaled change blocks serving until recovery replays it", async () => {
  const target = await draft();
  await expect(journaled(db("portal"), journal, { kind: "purge", pollId: target, reason: "draft_deleted" }, {
    prepare: async () => true,
    apply: async () => { throw new Error("simulated crash before commit"); },
  })).rejects.toThrow("simulated crash");
  await expect(assertJournalInSync(db("portal"), journal)).rejects.toThrow(/recovery procedure/);
  await expect(deleteDraft(db("portal"), owner, await draft(), keys, journal)).rejects.toThrow(/disagree/);
  await recoverDeployment(ops("observer"));
  await assertJournalInSync(db("portal"), journal);
  expect(await count("SELECT count(*) FROM polls WHERE id=$1", [target])).toBe(0);
  expect(await count("SELECT count(*) FROM operations.purge_tombstones WHERE poll_id=$1", [target])).toBe(1);
}, 60_000);

test("restoring a stale backup keeps serving disabled until journal replay withdraws restored open polls", async () => {
  const resumed = await opened(2), closedOk = await opened(5), deleted = await draft("Deleted later"), later = await opened(0);
  await closePoll(db("portal"), owner, closedOk.id);
  const forgotten = await participant(eligible[3]);
  // --- backup: a transactionally consistent copy of the database at this instant ---
  const backupName = `${new URL(url).pathname.slice(1)}_backup`;
  const backupUrl = new URL(url); backupUrl.pathname = `/${backupName}`;
  await endAll();
  const admin = new Client({ connectionString: Object.assign(new URL(url), { pathname: "/feedback_local" }).href });
  await admin.connect();
  try {
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()", [new URL(url).pathname.slice(1)]);
    await admin.query(`CREATE DATABASE ${backupName} TEMPLATE ${new URL(url).pathname.slice(1)}`);
  } finally { await admin.end(); }
  await connectAll();
  // --- after the backup: a deletion, a withdrawal, and a claim + response the backup will forget ---
  await deleteDraft(db("portal"), owner, deleted, keys, journal);
  await withdrawPoll(ops("operator"), later.id, "key_compromise");
  expect(await claim(resumed.id, forgotten, eligible[3], resumed.keyId)).toBe("claimed");
  const forgottenBody = { credential: await mintCredential(resumed.signer, resumed.id), answers: [{ questionId: rating.id, value: 4 }] };
  expect((await redeemResponse(db("publicDb"), resumed.id, forgottenBody)).status).toBe(201);
  const head = (await readJournal(journal)).seq;
  // --- restore: the deployment now points at the stale backup ---
  await endAll();
  await connectAll(backupUrl.href);
  try {
    await expect(assertJournalInSync(db("portal"), journal)).rejects.toThrow(/recovery procedure/);
    const report = await recoverDeployment(ops("observer"));
    expect(report).toMatchObject({ restoredOpenWithdrawn: 1, closedWithdrawn: 0 });
    await assertJournalInSync(db("portal"), journal);
    expect((await readJournal(journal)).seq).toBe(head + 1);
    const state = async (id: string) => (await db("observer").query(
      "SELECT state, invalidated, invalidation_reason FROM polls WHERE id=$1", [id])).rows[0];
    expect(await state(deleted)).toBeUndefined();
    expect(await count("SELECT count(*) FROM operations.purge_tombstones WHERE poll_id=$1", [deleted])).toBe(1);
    expect(await state(later.id)).toEqual({ state: "closed", invalidated: true, invalidation_reason: "key_compromise" });
    expect(await state(resumed.id)).toEqual({ state: "closed", invalidated: true, invalidation_reason: "restored_backup" });
    expect(await state(closedOk.id)).toEqual({ state: "closed", invalidated: false, invalidation_reason: null });
    expect((await db("observer").query("SELECT lifecycle FROM signing_keys WHERE poll_id=$1", [resumed.id])).rows[0].lifecycle).toBe("destroyed");
    // The rolled-back claim and nullifier cannot become usable in a resumed poll.
    expect(await claim(resumed.id, forgotten, eligible[3], resumed.keyId)).toBe("poll_withdrawn");
    await expect(redeemResponse(db("publicDb"), resumed.id, forgottenBody)).rejects.toMatchObject({ code: "poll_withdrawn" });
    expect((await readResults(db("portal"), owner, closedOk.id)).outcome).toBe("ready");
    // A missing, torn, truncated or edited journal keeps recovery offline.
    const text = await readFile(journal, "utf8");
    const lines = text.trimEnd().split("\n");
    for (const [label, broken] of [["truncated", `${lines.slice(0, -1).join("\n")}\n`], ["torn", text.slice(0, -1)],
      ["edited", text.replace("key_compromise", "operator")]] as const) {
      await writeFile(journal, broken);
      await expect(recoverDeployment(ops("observer")), label).rejects.toThrow(/journal/);
      await expect(assertJournalInSync(db("portal"), journal), label).rejects.toThrow();
    }
    await rm(journal);
    await expect(recoverDeployment(ops("observer"))).rejects.toThrow(/journal/);
    await writeFile(journal, text);
    // When the operator is uncertain, closed polls can be withdrawn as well.
    expect((await recoverDeployment(ops("observer"), { withdrawClosed: true })).closedWithdrawn).toBe(1);
    expect(await state(closedOk.id)).toMatchObject({ invalidated: true, invalidation_reason: "restored_backup" });
  } finally {
    await endAll();
    const cleanup = new Client({ connectionString: Object.assign(new URL(url), { pathname: "/feedback_local" }).href });
    await cleanup.connect();
    try { await cleanup.query(`DROP DATABASE IF EXISTS ${backupName} WITH (FORCE)`); } finally { await cleanup.end(); }
    await connectAll();
  }
}, 180_000);
