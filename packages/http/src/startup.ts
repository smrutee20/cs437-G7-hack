// Fail-closed startup checks shared by the production servers (SPEC.md §12, §16).
import { readFile, stat } from "node:fs/promises";

/** Reads a mounted secret; refuses one readable by group or others. Messages name the setting, never the path or value. */
export async function readSecretFile(path: string, name: string): Promise<Buffer> {
  let info;
  try { info = await stat(path); } catch { throw new Error(`SETUP ERROR: ${name} is unreadable`); }
  if (!info.isFile()) throw new Error(`SETUP ERROR: ${name} is not a file`);
  if ((info.mode & 0o077) !== 0) throw new Error(`SETUP ERROR: ${name} must not be readable by group or others`);
  if (process.getuid?.() !== undefined && info.uid !== process.getuid() && info.uid !== 0) {
    throw new Error(`SETUP ERROR: ${name} is owned by another account`);
  }
  return readFile(path);
}

/** A 32-byte key stored either raw or as unpadded base64url text. */
export function parseKeyMaterial(bytes: Buffer, name: string): Buffer {
  if (bytes.length === 32) return bytes;
  const text = bytes.toString("utf8").trim();
  if (/^[A-Za-z0-9_-]{43}$/.test(text)) {
    const decoded = Buffer.from(text, "base64url");
    if (decoded.length === 32 && decoded.toString("base64url") === text) return decoded;
  }
  throw new Error(`SETUP ERROR: ${name} must hold exactly 32 bytes`);
}

export const RUNTIME_ROLES = ["feedback_portal_admin", "feedback_issuer", "feedback_auth", "feedback_closer", "feedback_retention",
  "feedback_response_public", "feedback_key_janitor", "feedback_operator"] as const;
type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

/**
 * The pool's login must be a member of exactly its expected runtime role, must not
 * be a superuser, own the schema, bypass RLS or manage roles, and the server must
 * have durable commits on (fsync and synchronous_commit).
 */
export async function assertDatabaseRole(client: Queryable, expected: typeof RUNTIME_ROLES[number], setting: string): Promise<void> {
  const { rows } = await client.query(
    `SELECT r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb AS privileged,
            pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'public.polls'::regclass), 'MEMBER') AS owner,
            ARRAY(SELECT g FROM unnest($1::text[]) AS g
                   WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = g) AND pg_has_role(current_user, g, 'MEMBER')) AS memberships,
            current_setting('fsync') AS fsync, current_setting('synchronous_commit') AS synchronous_commit
       FROM pg_roles r WHERE r.rolname = current_user`, [RUNTIME_ROLES]);
  const row = rows[0];
  if (!row) throw new Error(`SETUP ERROR: ${setting} login is unavailable`);
  if (row.privileged || row.owner) throw new Error(`SETUP ERROR: ${setting} must not use a privileged or schema-owning database role`);
  const memberships = row.memberships as string[];
  if (memberships.length !== 1 || memberships[0] !== expected) {
    throw new Error(`SETUP ERROR: ${setting} must be a member of exactly ${expected}`);
  }
  if (row.fsync !== "on" || row.synchronous_commit !== "on") throw new Error("SETUP ERROR: database durable commits are not enabled");
}
