// Protected append-only recovery journal (SPEC.md §15), kept outside the
// database's rollback domain. Each line records only an event kind, poll ID,
// coarse reason and time, chained by SHA-256 to the previous line so a torn,
// edited or reordered journal is detected. A journaled change is acknowledged
// only after the line is fsynced and the database transaction (which advances
// operations.journal_state by exactly one) commits. Startup refuses to serve if
// the two disagree: an interrupted operation or a restored backup needs recovery.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Client } from "pg";
import { isCanonicalUuidV4 } from "@iitgn-feedback/protocol";

export type JournalKind = "withdraw" | "purge";
export const WITHDRAW_REASONS = ["key_compromise", "key_loss", "restored_backup", "integrity_failure", "privacy_incident", "operator"] as const;
export const PURGE_REASONS = ["draft_deleted", "draft_expired", "retention"] as const;
export type JournalEntry = { seq: number; kind: JournalKind; pollId: string; reason: string; at: string; prev: string };
export type Journal = { entries: JournalEntry[]; seq: number; hash: string };

const GENESIS = "0".repeat(64);
/** Transaction-scoped advisory lock serializing journal appends across processes. */
const JOURNAL_LOCK = "7366125432188403771";

export class JournalError extends Error {}

const lineHash = (line: string) => createHash("sha256").update(line, "utf8").digest("hex");
function serialize(entry: JournalEntry): string {
  // Fixed member order so the chain hash is reproducible.
  return JSON.stringify({ seq: entry.seq, kind: entry.kind, pollId: entry.pollId, reason: entry.reason, at: entry.at, prev: entry.prev });
}

function validEntry(value: unknown, seq: number, prev: string): value is JournalEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const e = value as Record<string, unknown>;
  if (Object.keys(e).join() !== "seq,kind,pollId,reason,at,prev") return false;
  const reasons: readonly string[] = e.kind === "withdraw" ? WITHDRAW_REASONS : e.kind === "purge" ? PURGE_REASONS : [];
  return e.seq === seq && e.prev === prev && isCanonicalUuidV4(e.pollId) && typeof e.reason === "string" &&
    reasons.includes(e.reason) && typeof e.at === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(e.at);
}

/** Reads and fully validates the journal. A missing file is an empty journal only when `allowMissing`. */
export async function readJournal(path: string, { allowMissing = true } = {}): Promise<Journal> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (cause) {
    if ((cause as { code?: string }).code === "ENOENT" && allowMissing) return { entries: [], seq: 0, hash: GENESIS };
    throw new JournalError("recovery journal unavailable");
  }
  if (text.length > 0 && !text.endsWith("\n")) throw new JournalError("recovery journal has a torn final line");
  const entries: JournalEntry[] = [];
  let hash = GENESIS;
  for (const line of text.split("\n").slice(0, -1)) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new JournalError("recovery journal is corrupt"); }
    if (!validEntry(value, entries.length + 1, hash) || serialize(value) !== line) {
      throw new JournalError("recovery journal is corrupt or out of order");
    }
    entries.push(value);
    hash = lineHash(line);
  }
  return { entries, seq: entries.length, hash };
}

async function append(path: string, head: Journal, entry: Pick<JournalEntry, "kind" | "pollId" | "reason">): Promise<JournalEntry> {
  const full: JournalEntry = { seq: head.seq + 1, ...entry, at: new Date().toISOString(), prev: head.hash };
  const line = serialize(full);
  const file = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(`${line}\n`);
    await file.sync();
  } finally { await file.close(); }
  if (head.seq === 0) {
    const dir = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try { await dir.sync(); } finally { await dir.close(); }
  }
  return full;
}

/** Fails closed unless the database has acknowledged exactly the journal's head. */
export async function assertJournalInSync(client: Client, path: string): Promise<void> {
  const journal = await readJournal(path);
  const { rows } = await client.query<{ seq: string }>("SELECT operations.journal_seq() AS seq");
  if (Number(rows[0].seq) !== journal.seq) {
    throw new JournalError("SETUP ERROR: database and recovery journal disagree (restored backup or interrupted operation); " +
      "keep ingress disabled and run the recovery procedure");
  }
}

/**
 * Runs one journaled change: under the journal lock, `prepare` takes the poll lock
 * and decides whether to proceed; then the entry is appended and fsynced; then
 * `apply` makes the change and acknowledges `seq`; then the transaction commits.
 */
export async function journaled<T>(client: Client, path: string, entry: Pick<JournalEntry, "kind" | "pollId" | "reason">, steps: {
  prepare: () => Promise<boolean>;
  apply: (seq: number) => Promise<T>;
}): Promise<{ applied: false } | { applied: true; result: T; entry: JournalEntry }> {
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  try {
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query(`SELECT pg_advisory_xact_lock(${JOURNAL_LOCK})`);
    const head = await readJournal(path);
    const { rows } = await client.query<{ seq: string }>("SELECT operations.journal_seq() AS seq");
    if (Number(rows[0].seq) !== head.seq) throw new JournalError("database and recovery journal disagree");
    if (!(await steps.prepare())) {
      await client.query("ROLLBACK");
      return { applied: false };
    }
    const written = await append(path, head, entry);
    const result = await steps.apply(written.seq);
    await client.query("COMMIT");
    return { applied: true, result, entry: written };
  } catch (cause) {
    await client.query("ROLLBACK").catch(() => {});
    throw cause;
  }
}

export { append as appendJournalEntry, JOURNAL_LOCK };
