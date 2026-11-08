// Milestone 5 gated results (SPEC.md §11) against real PostgreSQL. Expected
// aggregates are computed by hand, including half-up rounding boundaries.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, expect, inject, test } from "vitest";
import { createDraft } from "../../services/portal-api/src/create-draft";
import { loadPrivateKey } from "../../services/portal-api/src/keys";
import { migrateFoundation, rollbackFoundation } from "../../services/portal-api/src/migrate";
import { closePoll, openPoll } from "../../services/portal-api/src/poll-lifecycle";
import { readResults } from "../../services/portal-api/src/results";
import { redeemResponse } from "../../services/respond-api/src/redeem";
import { mintCredential } from "../fixtures/mint";

const url = inject("testDatabaseUrl"), master = randomBytes(32), owner = randomUUID(), other = randomUUID();
const observer = new Client({ connectionString: url }), portal = new Client({ connectionString: url });
const publicDb = new Client({ connectionString: url });
let directory: string;

type Q = { id: string; type: string; prompt: string; required: boolean; options?: { id: string; label: string }[] };
async function openedPoll(questions: Q[]) {
  const { id } = await createDraft(portal, owner, { title: "Results", description: "",
    closesAt: new Date(Date.now() + 86_400_000).toISOString(), questions,
    eligibilityEmails: Array.from({ length: 10 }, (_, i) => `student${i}@iitgn.ac.in`) }, directory, master);
  await openPoll(portal, owner, id, 1);
  const key = (await observer.query("SELECT key_id, public_jwk, private_secret_ref FROM signing_keys WHERE poll_id=$1", [id])).rows[0];
  const der = await loadPrivateKey(directory, master, key.private_secret_ref);
  const submit = async (answers: { questionId: string; value: string | number }[]) => {
    const credential = await mintCredential({ keyId: key.key_id, jwk: key.public_jwk, der }, id);
    expect((await redeemResponse(publicDb, id, { credential, answers })).status).toBe(201);
  };
  return { id, submit };
}
const choiceQ = (): Q & { options: { id: string; label: string }[] } => ({ id: randomUUID(), type: "single_choice", prompt: "Pick", required: true,
  options: [{ id: randomUUID(), label: "A" }, { id: randomUUID(), label: "B" }, { id: randomUUID(), label: "C" }] });
const ratingQ = (): Q => ({ id: randomUUID(), type: "rating", prompt: "Rate", required: false });
const textQ = (prompt = "Say"): Q => ({ id: randomUUID(), type: "free_text", prompt, required: false });

beforeAll(async () => {
  await migrateFoundation(url);
  directory = await mkdtemp(join(tmpdir(), "feedback-results-"));
  for (const client of [observer, portal, publicDb]) await client.connect();
  await observer.query(`INSERT INTO identity.users(id,issuer,subject,email,is_organiser) VALUES
    ($1,'https://accounts.google.com','results-owner','owner@iitgn.ac.in',true),
    ($2,'https://accounts.google.com','results-other','other@iitgn.ac.in',true)`, [owner, other]);
  await portal.query("SET ROLE feedback_portal_admin");
  await publicDb.query("SET ROLE feedback_response_public");
});
afterAll(async () => {
  for (const client of [observer, portal, publicDb]) await client.end();
  await rollbackFoundation(url);
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("results are refused before closure, hidden from other organisers, and four responses are withheld permanently", async () => {
  const choice = choiceQ();
  const poll = await openedPoll([choice]);
  for (let i = 0; i < 4; i++) await poll.submit([{ questionId: choice.id, value: choice.options[0].id }]);
  expect(await readResults(portal, owner, poll.id)).toEqual({ outcome: "results_not_closed" });
  expect(await readResults(portal, other, poll.id)).toEqual({ outcome: "not_found" });
  expect(await readResults(portal, owner, randomUUID())).toEqual({ outcome: "not_found" });
  await closePoll(portal, owner, poll.id);
  expect(await readResults(portal, other, poll.id)).toEqual({ outcome: "not_found" }); // ownership before thresholds
  const withheld = { outcome: "ready", result: { state: "withheld", reason: "insufficient_responses" } };
  expect(await readResults(portal, owner, poll.id)).toEqual(withheld);
  expect(await readResults(portal, owner, poll.id)).toEqual(withheld);
  // The portal role still cannot read responses or snapshots directly.
  for (const sql of ["SELECT * FROM anonymous.responses", "SELECT * FROM anonymous.result_snapshots"]) {
    await expect(portal.query(sql)).rejects.toMatchObject({ code: "42501" });
  }
  await expect(publicDb.query("SELECT * FROM anonymous.result_snapshots")).rejects.toMatchObject({ code: "42501" });
});

test("five responses publish exact aggregates in schema order; a question with four answers is withheld", async () => {
  const choice = choiceQ(), rating = ratingQ(), sparse = ratingQ(), text = textQ();
  const poll = await openedPoll([choice, rating, sparse, text]);
  const [a, b, c] = choice.options.map((option) => option.id);
  const rows: [string, number, number | null, string | null][] = [
    [a, 1, 5, "Great"], [a, 1, 4, "Great"], [b, 2, 3, "Too long"], [b, 3, 2, null], [b, 3, null, "Fine"],
    [a, 3, null, "Useful"], [a, 2, null, null], [a, 2, null, null],
  ]; // 8 responses: choice A×5, B×3, C×0; rating [1,1,2,3,3,3,2,2] (sum 17); sparse answered 4 times; text 5 nonempty
  for (const [pick, score, extra, remark] of rows) {
    await poll.submit([{ questionId: choice.id, value: pick }, { questionId: rating.id, value: score },
      ...(extra === null ? [] : [{ questionId: sparse.id, value: extra }]),
      ...(remark === null ? [] : [{ questionId: text.id, value: remark }])]);
  }
  await closePoll(portal, owner, poll.id);
  const { outcome, result } = await readResults(portal, owner, poll.id) as { outcome: string; result: any };
  expect(outcome).toBe("ready");
  expect(result).toMatchObject({ state: "ready", totalResponses: 8 });
  expect(result.questions.map((q: any) => q.questionId)).toEqual([choice.id, rating.id, sparse.id, text.id]);
  expect(result.questions[0]).toEqual({ questionId: choice.id, state: "published", type: "single_choice",
    answeredCount: 8, skippedCount: 0, options: [
      { optionId: a, count: 5, percentage: 62.5 }, { optionId: b, count: 3, percentage: 37.5 }, { optionId: c, count: 0, percentage: 0 },
    ] });
  // rating: 1×2, 2×3, 3×3 of 8 → 25, 37.5, 37.5, 0, 0; mean 17/8 = 2.125 → 2.13 (half-up, not banker's 2.12)
  expect(result.questions[1]).toEqual({ questionId: rating.id, state: "published", type: "rating",
    answeredCount: 8, skippedCount: 0, mean: 2.13, distribution: [
      { value: 1, count: 2, percentage: 25 }, { value: 2, count: 3, percentage: 37.5 }, { value: 3, count: 3, percentage: 37.5 },
      { value: 4, count: 0, percentage: 0 }, { value: 5, count: 0, percentage: 0 },
    ] });
  expect(result.questions[2]).toEqual({ questionId: sparse.id, state: "withheld", reason: "insufficient_answers" });
  expect(Object.keys(result.questions[3]).sort()).toEqual(["answeredCount", "questionId", "skippedCount", "state", "texts", "type"]);
  expect(result.questions[3]).toMatchObject({ state: "published", type: "free_text", answeredCount: 5, skippedCount: 3 });
  expect([...result.questions[3].texts].sort()).toEqual(["Fine", "Great", "Great", "Too long", "Useful"]); // duplicates kept
  expect(Object.keys(result).sort()).toEqual(["questions", "state", "totalResponses"]);
});

test("percentages round half-up to one decimal", async () => {
  const choice = choiceQ();
  const poll = await openedPoll([choice]);
  // 16 answers: 1 / 16 = 6.25% → 6.3 and 15 / 16 = 93.75% → 93.8 (banker's rounding would give 6.2)
  for (let i = 0; i < 16; i++) await poll.submit([{ questionId: choice.id, value: choice.options[i === 0 ? 0 : 1].id }]);
  await closePoll(portal, owner, poll.id);
  const { result } = await readResults(portal, owner, poll.id) as { result: any };
  expect(result.questions[0].options.map((o: any) => o.percentage)).toEqual([6.3, 93.8, 0]);
});

test("a ready snapshot is immutable, holds no linkage, and shuffles each free-text question independently", async () => {
  const orders: { first: string[]; second: string[] }[] = [];
  for (let round = 0; round < 5; round++) {
    const choice = choiceQ(), first = textQ("First"), second = textQ("Second");
    const poll = await openedPoll([choice, first, second]);
    for (let i = 0; i < 6; i++) {
      await poll.submit([{ questionId: choice.id, value: choice.options[0].id },
        { questionId: first.id, value: `r${i}` }, { questionId: second.id, value: `r${i}` }]);
    }
    await closePoll(portal, owner, poll.id);
    const once = await readResults(portal, owner, poll.id) as { result: any };
    expect(await readResults(portal, owner, poll.id)).toEqual(once); // persisted, not recomputed
    const snapshot = (await observer.query("SELECT result FROM anonymous.result_snapshots WHERE poll_id=$1", [poll.id])).rows[0].result;
    expect(snapshot).toEqual(once.result);
    const nullifiers = (await observer.query("SELECT encode(nullifier,'hex') AS n FROM anonymous.responses WHERE poll_id=$1", [poll.id])).rows;
    for (const { n } of nullifiers) expect(JSON.stringify(snapshot)).not.toContain(n);
    orders.push({ first: once.result.questions[1].texts, second: once.result.questions[2].texts });
  }
  const insertion = ["r0", "r1", "r2", "r3", "r4", "r5"];
  for (const order of orders) expect([...order.first].sort()).toEqual(insertion);
  // Independent cryptographic shuffles: chance coincidence per poll is 1/720, so across five polls the
  // two questions' orders differ at least once, and neither simply follows insertion order every time.
  expect(orders.some((order) => order.first.join() !== order.second.join())).toBe(true);
  expect(orders.some((order) => order.first.join() !== insertion.join())).toBe(true);
}, 60_000); // five 3072-bit key generations; Vitest's 5 s default is a harness limit, not a product budget

test("publication materializes deadline closure and waits for an admitted in-flight response", async () => {
  const choice = choiceQ();
  const poll = await openedPoll([choice]);
  for (let i = 0; i < 4; i++) await poll.submit([{ questionId: choice.id, value: choice.options[0].id }]);
  await observer.query("SET session_replication_role = replica");
  await observer.query("UPDATE polls SET closes_at=clock_timestamp() + interval '1500 milliseconds' WHERE id=$1", [poll.id]);
  await observer.query("SET session_replication_role = origin");
  const key = (await observer.query("SELECT key_id, public_jwk, private_secret_ref FROM signing_keys WHERE poll_id=$1", [poll.id])).rows[0];
  const credential = await mintCredential({ keyId: key.key_id, jwk: key.public_jwk,
    der: await loadPrivateKey(directory, master, key.private_secret_ref) }, poll.id);
  // A fifth response is admitted before the deadline but not yet committed.
  const inflight = new Client({ connectionString: url });
  await inflight.connect();
  try {
    await inflight.query("SET ROLE feedback_response_public");
    await inflight.query("BEGIN");
    const nullifier = (await import("node:crypto")).createHash("sha256").update(Buffer.concat([
      Buffer.from("IITGN-FEEDBACK-SPENT\0", "ascii"), Buffer.of(1), Buffer.from(poll.id.replaceAll("-", ""), "hex"),
      Buffer.from(credential.preparedMessage, "base64url").subarray(79)])).digest();
    expect((await inflight.query("SELECT anonymous.redeem($1,$2,$3::jsonb) AS o",
      [poll.id, nullifier, JSON.stringify([{ questionId: choice.id, value: choice.options[1].id }])])).rows[0].o).toBe("inserted");
    await expect.poll(async () => (await observer.query("SELECT clock_timestamp() >= closes_at AS past FROM polls WHERE id=$1",
      [poll.id])).rows[0].past, { timeout: 5000 }).toBe(true);
    const publisher = new Client({ connectionString: url });
    await publisher.connect();
    try {
      await publisher.query("SET ROLE feedback_portal_admin");
      const pid = (await publisher.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const pending = readResults(publisher, owner, poll.id);
      await expect.poll(async () => (await observer.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.wait_event_type).toBe("Lock");
      await inflight.query("COMMIT");
      const { outcome, result } = await pending as { outcome: string; result: any };
      expect(outcome).toBe("ready");
      expect(result.totalResponses).toBe(5); // the admitted response is in the stable final set
    } finally { await publisher.end(); }
  } finally { await inflight.end(); }
  expect((await observer.query("SELECT state, closed_at = closes_at AS at_deadline FROM polls WHERE id=$1", [poll.id])).rows[0])
    .toEqual({ state: "closed", at_deadline: true });
});

test("a withdrawn poll never shows results", async () => {
  const choice = choiceQ();
  const poll = await openedPoll([choice]);
  for (let i = 0; i < 5; i++) await poll.submit([{ questionId: choice.id, value: choice.options[0].id }]);
  await closePoll(portal, owner, poll.id);
  await observer.query("UPDATE polls SET invalidated=true WHERE id=$1", [poll.id]);
  expect(await readResults(portal, owner, poll.id)).toEqual({ outcome: "poll_withdrawn" });
});

test("publication takes the conflicting closure lock even on a closed poll, and concurrent first reads share one snapshot", async () => {
  const choice = choiceQ(), text = textQ();
  const poll = await openedPoll([choice, text]);
  for (let i = 0; i < 5; i++) await poll.submit([{ questionId: choice.id, value: choice.options[0].id }, { questionId: text.id, value: `t${i}` }]);
  await closePoll(portal, owner, poll.id);
  // A shared poll lock, as an identical-retry redemption takes after closure.
  const holder = new Client({ connectionString: url });
  await holder.connect();
  const publishers = await Promise.all(Array.from({ length: 4 }, async () => {
    const client = new Client({ connectionString: url });
    await client.connect();
    await client.query("SET ROLE feedback_portal_admin");
    return client;
  }));
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM polls WHERE id=$1 FOR SHARE", [poll.id]);
    const pids = await Promise.all(publishers.map(async (client) => (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid));
    const pending = publishers.map((client) => readResults(client, owner, poll.id));
    await expect.poll(async () => (await observer.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = ANY($1) AND wait_event_type = 'Lock'", [pids])).rows[0].n).toBe(4);
    await holder.query("COMMIT");
    const results = await Promise.all(pending);
    expect(results.every((result) => JSON.stringify(result) === JSON.stringify(results[0]))).toBe(true);
    expect((await observer.query("SELECT count(*)::int AS n FROM anonymous.result_snapshots WHERE poll_id=$1", [poll.id])).rows[0].n).toBe(1);
  } finally {
    await holder.end();
    await Promise.all(publishers.map((client) => client.end()));
  }
});
