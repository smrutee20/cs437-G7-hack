import { isCanonicalUuidV4 } from "@iitgn-feedback/protocol";
import type { Client } from "pg";
import { journaled } from "./journal.js";
import { PollError } from "./poll-lifecycle.js";
import { unlinkPollKeys } from "./key-files.js";

// Journal entry, then the database deletion and tombstone (acknowledging that
// entry), then key-file removal after commit. An ambiguous commit must never
// trigger key deletion: the DB may still refer to that key.
export async function deleteDraft(client: Client, owner: string, id: string, keyDirectory: string, journalPath: string): Promise<void> {
  if (!isCanonicalUuidV4(id)) throw new PollError("not_found");
  let keyId: string | undefined;
  let outcome;
  try {
    outcome = await journaled(client, journalPath, { kind: "purge", pollId: id, reason: "draft_deleted" }, {
      prepare: async () => {
        const { rows } = await client.query<{ state: string; key_id: string }>(
          `SELECT p.state, k.key_id FROM polls p JOIN signing_keys k ON k.poll_id = p.id
            WHERE p.id = $1 AND p.organiser_id = $2 FOR UPDATE OF p`, [id, owner]);
        if (!rows[0]) throw new PollError("not_found");
        if (rows[0].state !== "draft") throw new PollError("invalid_state");
        keyId = rows[0].key_id;
        return true;
      },
      apply: async (seq) => {
        const result = await client.query<{ deleted: boolean }>("SELECT delete_draft_poll($1, $2, $3) AS deleted", [id, owner, seq]);
        if (result.rows[0]?.deleted !== true) throw new PollError("not_found");
      },
    });
  } catch (cause) {
    if ((cause as { code?: string }).code === "23514") throw new PollError("invalid_state");
    throw cause;
  }
  if (outcome.applied && keyId) await unlinkPollKeys(keyDirectory, [keyId]);
}
