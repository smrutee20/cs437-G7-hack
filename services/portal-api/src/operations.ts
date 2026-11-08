// Background retention and operator procedures (SPEC.md §6 key lifecycle, §15).
// None of these is reachable from an organiser or participant route. Nothing
// here logs identities, answers or key material; results are counts only.
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { Client } from "pg";
import { isCanonicalUuidV4 } from "@iitgn-feedback/protocol";
import { checkedDirectory, unlinkPollKeys as unlinkKeys } from "./key-files.js";
import {
  appendJournalEntry, JOURNAL_LOCK, journaled, JournalError, readJournal, WITHDRAW_REASONS, type JournalEntry,
} from "./journal.js";

export type OperationsContext = { client: Client; journalPath: string; keyDirectory: string };
export type WithdrawReason = typeof WITHDRAW_REASONS[number];

async function inTransaction<T>(client: Client, action: () => Promise<T>, statementTimeout = "5s"): Promise<T> {
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  try {
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query(`SET LOCAL statement_timeout = '${statementTimeout}'`);
    const result = await action();
    await client.query("COMMIT");
    return result;
  } catch (cause) {
    await client.query("ROLLBACK").catch(() => {});
    throw cause;
  }
}

/** Deletes private keys marked for destruction: file first, then the database marker. */
export async function destroyPendingKeys({ client, keyDirectory }: Omit<OperationsContext, "journalPath">): Promise<number> {
  const { rows } = await client.query<{ key_id: string; private_secret_ref: string }>(
    "SELECT key_id, private_secret_ref FROM operations.keys_pending_destruction()");
  await unlinkKeys(keyDirectory, rows.map((row) => row.private_secret_ref));
  for (const row of rows) await client.query("SELECT operations.mark_key_destroyed($1)", [row.key_id]);
  return rows.length;
}

/** One hourly retention run (feedback_retention role): sweep, journaled purges, key destruction. */
export async function runRetention(context: OperationsContext): Promise<{ purged: number; keysDestroyed: number }> {
  await inTransaction(context.client, async () => { await context.client.query("SELECT operations.retention_sweep()"); });
  const candidates = (await context.client.query<{ poll_id: string; reason: "retention" | "draft_expired" }>(
    "SELECT poll_id, reason FROM operations.purge_candidates()")).rows;
  let purged = 0;
  for (const { poll_id: pollId, reason } of candidates) {
    const outcome = await journaled(context.client, context.journalPath, { kind: "purge", pollId, reason }, {
      prepare: async () => (await context.client.query<{ due: boolean }>(
        "SELECT operations.lock_purge_candidate($1, $2) AS due", [pollId, reason])).rows[0].due,
      apply: async (seq) => (await context.client.query<{ ref: string | null }>(
        "SELECT operations.purge_poll($1, $2, $3) AS ref", [pollId, reason, seq])).rows[0].ref,
    });
    if (outcome.applied) { purged++; await unlinkKeys(context.keyDirectory, [outcome.result]); }
  }
  return { purged, keysDestroyed: await destroyPendingKeys(context) };
}

/** Operator emergency withdrawal (feedback_operator role). Journal first, then the locked change. */
export async function withdrawPoll(context: OperationsContext, pollId: string, reason: WithdrawReason): Promise<"withdrawn" | "absent"> {
  if (!isCanonicalUuidV4(pollId) || !WITHDRAW_REASONS.includes(reason)) throw new Error("invalid withdrawal request");
  const outcome = await journaled(context.client, context.journalPath, { kind: "withdraw", pollId, reason }, {
    prepare: async () => (await context.client.query("SELECT operations.lock_poll($1) AS state", [pollId])).rows[0].state !== null,
    apply: async (seq) => (await context.client.query("SELECT operations.withdraw_poll($1, $2, $3)", [pollId, reason, seq])),
  });
  if (!outcome.applied) return "absent";
  await destroyPendingKeys(context);
  return "withdrawn";
}

/** Draft/open polls whose private key file is missing: an incident, never a reason to regenerate. */
export async function findMissingKeys({ client, keyDirectory }: Omit<OperationsContext, "journalPath">): Promise<{ pollId: string; state: string }[]> {
  await checkedDirectory(keyDirectory);
  const { rows } = await client.query<{ poll_id: string; state: string; private_secret_ref: string }>(
    "SELECT poll_id, state, private_secret_ref FROM operations.live_key_refs()");
  const missing: { pollId: string; state: string }[] = [];
  for (const row of rows) {
    if (!isCanonicalUuidV4(row.private_secret_ref)) { missing.push({ pollId: row.poll_id, state: row.state }); continue; }
    try { await lstat(join(keyDirectory, row.private_secret_ref)); }
    catch (cause) {
      if ((cause as { code?: string }).code !== "ENOENT") throw cause;
      missing.push({ pollId: row.poll_id, state: row.state });
    }
  }
  return missing;
}

export async function setOrganiser(client: Client, subject: string, organiser: boolean): Promise<boolean> {
  if (typeof subject !== "string" || subject.length === 0 || subject.length > 255) throw new Error("invalid subject");
  return (await client.query<{ found: boolean }>("SELECT operations.set_organiser('https://accounts.google.com', $1, $2) AS found",
    [subject, organiser])).rows[0].found;
}

export type RecoveryReport = { replayed: number; restoredOpenWithdrawn: number; closedWithdrawn: number; purged: number; keysDestroyed: number };

/**
 * Offline recovery after restoring a database backup (SPEC.md §15). Runs with the
 * deployment-only owner credential while ingress stays disabled. Replays the
 * journal, applies tombstones, withdraws every poll that was open in the restored
 * database (a rollback may have forgotten claims or nullifiers), withdraws closed
 * polls that are inconsistent (or all closed polls if requested), applies
 * retention, destroys affected keys, and only then re-acknowledges the journal.
 */
export async function recoverDeployment(context: OperationsContext, options: { withdrawClosed?: boolean } = {}): Promise<RecoveryReport> {
  const { client } = context;
  // The journal must exist and be intact; a missing or torn journal keeps recovery offline.
  const journal = await readJournal(context.journalPath, { allowMissing: false });
  const report = await inTransaction(client, async () => {
    await client.query(`SELECT pg_advisory_xact_lock(${JOURNAL_LOCK})`);
    const dbSeq = Number((await client.query("SELECT last_seq FROM operations.journal_state")).rows[0].last_seq);
    if (dbSeq > journal.seq) throw new JournalError("recovery journal is incomplete: the database acknowledged entries it lacks");
    let head = { ...journal };
    const refs: (string | null)[] = [];
    const purgeNow = async (pollId: string) => {
      refs.push(...(await client.query<{ ref: string | null }>(
        "SELECT private_secret_ref AS ref FROM signing_keys WHERE poll_id = $1", [pollId])).rows.map((row) => row.ref));
      await client.query("SELECT operations.purge_poll_now($1)", [pollId]);
    };
    const record = async (entry: Pick<JournalEntry, "kind" | "pollId" | "reason">) => {
      const written = await appendJournalEntry(context.journalPath, head, entry);
      head = { entries: [...head.entries, written], seq: written.seq, hash: (await readJournal(context.journalPath)).hash };
    };
    const withdraw = async (pollId: string, reason: string) => {
      await client.query(
        `UPDATE polls SET invalidated = true, invalidation_reason = COALESCE(invalidation_reason, $2),
                state = CASE WHEN state = 'open' THEN 'closed' ELSE state END,
                closed_at = CASE WHEN state = 'open' THEN LEAST(closes_at, clock_timestamp()) ELSE closed_at END,
                updated_at = clock_timestamp()
          WHERE id = $1`, [pollId, reason]);
      await client.query("UPDATE signing_keys SET lifecycle = 'destroy_pending' WHERE poll_id = $1 AND lifecycle = 'active'", [pollId]);
    };
    // 1. Replay every decision; each is idempotent and the journal is authoritative.
    for (const entry of journal.entries) {
      if (entry.kind === "withdraw") await withdraw(entry.pollId, entry.reason);
      else await purgeNow(entry.pollId);
    }
    // 2. Retained tombstones: nothing tombstoned may reappear.
    for (const { poll_id } of (await client.query<{ poll_id: string }>(
      "SELECT t.poll_id FROM operations.purge_tombstones t JOIN polls p ON p.id = t.poll_id")).rows) {
      await purgeNow(poll_id);
    }
    // 3. Every poll open in the recovered database is withdrawn and closed permanently.
    const open = (await client.query<{ id: string }>("SELECT id FROM polls WHERE state = 'open' ORDER BY id")).rows;
    for (const { id } of open) { await record({ kind: "withdraw", pollId: id, reason: "restored_backup" }); await withdraw(id, "restored_backup"); }
    // 4. Closed polls stay readable only if consistent (or are all withdrawn on request).
    const closed = (await client.query<{ id: string }>(
      `SELECT id FROM polls WHERE state = 'closed' AND NOT invalidated
         AND ($1 OR opened_at IS NULL OR closed_at IS NULL OR closed_at > closes_at OR closed_at < opened_at) ORDER BY id`,
      [options.withdrawClosed === true])).rows;
    for (const { id } of closed) {
      const reason = options.withdrawClosed ? "restored_backup" : "integrity_failure";
      await record({ kind: "withdraw", pollId: id, reason }); await withdraw(id, reason);
    }
    // 5. Expired-data deletions and due purges.
    await client.query("SELECT operations.retention_sweep()");
    let purged = 0;
    for (const { poll_id: pollId, reason } of (await client.query<{ poll_id: string; reason: "retention" | "draft_expired" }>(
      "SELECT poll_id, reason FROM operations.purge_candidates()")).rows) {
      await record({ kind: "purge", pollId, reason });
      await purgeNow(pollId);
      purged++;
    }
    // 6. Re-acknowledge the journal only now; until this commits, startup still refuses.
    await client.query("UPDATE operations.journal_state SET last_seq = $1", [head.seq]);
    return { replayed: journal.entries.length, restoredOpenWithdrawn: open.length, closedWithdrawn: closed.length, purged, keysDestroyed: 0, refs };
  }, "60s");
  await unlinkKeys(context.keyDirectory, report.refs);
  report.keysDestroyed = await destroyPendingKeys(context);
  delete (report as { refs?: unknown }).refs;
  return report;
}
