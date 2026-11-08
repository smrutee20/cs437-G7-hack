import { isCanonicalUuidV4 } from "@iitgn-feedback/protocol";
import type { Client } from "pg";
import { validateDraftInput } from "./draft.js";

type Status = "draft" | "open" | "closed";
type Outcome = { status: Status; revision: number };
type PollRow = { status: Status; revision: number; title: string; description: string; closes_at: Date; questions: unknown };

export class PollError extends Error {
  constructor(readonly code: "not_found" | "draft_conflict" | "invalid_state" | "validation_failed") {
    super(code);
  }
}

// Every operation uses a dedicated client in a READ COMMITTED transaction.
// Never share a Client across concurrent request handlers.
async function locked<T>(client: Client, owner: string, id: string,
  action: (row: PollRow) => Promise<T>): Promise<T> {
  if (!isCanonicalUuidV4(id)) throw new PollError("not_found");
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  try {
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '2s'");
    const { rows } = await client.query<PollRow>(
      `SELECT state AS status, revision, title, description, closes_at, questions
         FROM polls WHERE id=$1 AND organiser_id=$2 FOR UPDATE`, [id, owner],
    );
    if (!rows[0]) throw new PollError("not_found");
    const result = await action(rows[0]);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function updateDraft(client: Client, owner: string, id: string,
  revision: number, input: unknown): Promise<Outcome> {
  return locked(client, owner, id, async (row) => {
    if (row.status !== "draft") throw new PollError("invalid_state");
    if (!Number.isSafeInteger(revision) || row.revision !== revision) throw new PollError("draft_conflict");
    const draft = validateDraftInput(input);
    await client.query(
      `UPDATE polls SET title=$2,description=$3,closes_at=$4,questions=$5::jsonb,
         eligible_count=$6,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1`,
      [id, draft.title, draft.description, draft.closesAt, JSON.stringify(draft.questions), draft.eligibilityEmails.length],
    );
    await client.query("DELETE FROM identity.eligibility WHERE poll_id=$1", [id]);
    await client.query("INSERT INTO identity.eligibility(poll_id,email) SELECT $1,unnest($2::text[])",
      [id, draft.eligibilityEmails]);
    return { status: "draft", revision: row.revision + 1 };
  });
}

export async function openPoll(client: Client, owner: string, id: string, revision: number): Promise<Outcome> {
  return locked(client, owner, id, async (row) => {
    if (row.status === "closed") throw new PollError("invalid_state");
    if (row.status === "open") {
      const { rows: clock } = await client.query<{ expired: boolean }>(
        "SELECT clock_timestamp() >= closes_at AS expired FROM polls WHERE id=$1", [id],
      );
      if (clock[0].expired) {
        await client.query(
          "UPDATE polls SET state='closed',closed_at=closes_at,updated_at=clock_timestamp() WHERE id=$1", [id],
        );
        return { status: "closed", revision: row.revision };
      }
      if (row.revision === revision) return { status: "open", revision };
      throw new PollError("draft_conflict");
    }
    if (!Number.isSafeInteger(revision) || row.revision !== revision) throw new PollError("draft_conflict");
    const emails = (await client.query<{email:string}>(
      "SELECT email FROM identity.eligibility WHERE poll_id=$1 ORDER BY email", [id],
    )).rows.map((item) => item.email);
    validateDraftInput({ title: row.title, description: row.description,
      closesAt: row.closes_at.toISOString(), questions: row.questions, eligibilityEmails: emails });
    const key = await client.query("SELECT key_id FROM signing_keys WHERE poll_id=$1", [id]);
    if (key.rowCount !== 1) throw new PollError("validation_failed");
    const opened = await client.query(
      `UPDATE polls SET state='open',opened_at=clock_timestamp(),updated_at=clock_timestamp()
         WHERE id=$1 AND closes_at >= clock_timestamp() + interval '10 minutes'
                     AND closes_at <= clock_timestamp() + interval '30 days'`, [id],
    );
    if (opened.rowCount !== 1) throw new PollError("validation_failed");
    return { status: "open", revision };
  });
}

export async function closePoll(client: Client, owner: string, id: string): Promise<Outcome> {
  return locked(client, owner, id, async (row) => {
    if (row.status === "draft") throw new PollError("invalid_state");
    if (row.status === "open") await client.query(
      `UPDATE polls SET state='closed',closed_at=LEAST(closes_at,clock_timestamp()),
         updated_at=clock_timestamp() WHERE id=$1`, [id],
    );
    return { status: "closed", revision: row.revision };
  });
}
