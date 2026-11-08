import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Client } from "pg";
import { validateDraftInput } from "./draft.js";
import { provisionPollKey } from "./keys.js";

// Caller must supply an authenticated server-side user ID, never one from JSON.
// `client` must use feedback_portal_admin, not the migration/database owner.
export async function createDraft(client: Client, authenticatedUserId: string, input: unknown,
  keyDirectory: string, encryptionKey: Buffer): Promise<{ id: string }> {
  // Validate the entire input before generating or writing a private key.
  const draft = validateDraftInput(input);
  const id = randomUUID();
  const key = await provisionPollKey(keyDirectory, encryptionKey);
  try {
    // A single statement: the security-definer function checks provisioning and
    // inserts the poll, key metadata and complete allowlist atomically.
    await client.query(
      `SELECT create_draft_poll($1,$2,$3,$4,$5::timestamptz,$6::jsonb,$7,$8::jsonb,$9::bytea,$10,$11::text[])`,
      [id, authenticatedUserId, draft.title, draft.description, draft.closesAt,
        JSON.stringify(draft.questions), key.keyId, JSON.stringify(key.publicJwk),
        key.fingerprint, key.privateSecretRef, draft.eligibilityEmails],
    );
  } catch (error) {
    // A definite SQL constraint/permission failure aborts this statement; no
    // database row can reference the file. Never remove it for a connection or
    // ambiguous commit failure: that could destroy a live poll's private key.
    if (typeof (error as { code?: unknown }).code === "string" &&
        /^(22|23|42501)/.test((error as { code: string }).code)) {
      await unlink(join(keyDirectory, key.privateSecretRef));
      const dir = await open(keyDirectory, constants.O_RDONLY | constants.O_DIRECTORY);
      try { await dir.sync(); } finally { await dir.close(); }
    }
    throw error;
  }
  return { id };
}
