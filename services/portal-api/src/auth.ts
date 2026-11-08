// Portal server-side sessions (SPEC.md §5). The cookie carries a 256-bit random
// opaque token; the database stores only its SHA-256. A separate 256-bit
// synchronizer CSRF token is returned by GET /session. Sessions expire
// absolutely after eight hours, rotate on login, and are never shared with the
// response origin. Runs under the dedicated feedback_auth database role.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { Client } from "pg";

export type Lease = () => Promise<{ client: Client; release: () => Promise<void> }>;
export type Session = { id: string; email: string; isOrganiser: boolean; csrfToken: string };
export type VerifiedIdentity = { issuer: "https://accounts.google.com"; subject: string; email: string };
export type SessionStore = {
  authenticate: (request: FastifyRequest) => Promise<Session | null>;
  /** Upserts the (issuer, subject) user and creates a fresh session, revoking `previousToken`. */
  establish: (identity: VerifiedIdentity, previousToken?: string) => Promise<{ token: string; maxAgeSeconds: number }>;
  revoke: (token: string) => Promise<void>;
};

export const SESSION_COOKIE = "__Host-session";
export const PREAUTH_COOKIE = "__Host-preauth";
export const SESSION_SECONDS = 8 * 60 * 60;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const randomToken = () => randomBytes(32).toString("base64url");
export const tokenHash = (token: string) => createHash("sha256").update(token, "utf8").digest();
export function sameToken(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest(), right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

/** Reads one host-only cookie holding a canonical 256-bit token; anything else is absent. */
export function readTokenCookie(header: string | undefined, name: string): string | undefined {
  if (typeof header !== "string" || header.length > 8192) return undefined;
  const values = header.split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  if (values.length !== 1 || !TOKEN.test(values[0])) return undefined;
  if (Buffer.from(values[0], "base64url").toString("base64url") !== values[0]) return undefined;
  return values[0];
}
export const hostCookie = (name: string, value: string, maxAge: number) =>
  `${name}=${value}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
export const clearedCookie = (name: string) => `${name}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;

export function createSessionStore(acquire: Lease): SessionStore {
  const withClient = async <T>(action: (client: Client) => Promise<T>): Promise<T> => {
    const { client, release } = await acquire();
    try { return await action(client); } finally { await release(); }
  };
  return {
    authenticate: async (request) => {
      const token = readTokenCookie(request.headers.cookie, SESSION_COOKIE);
      if (!token) return null;
      // The organiser flag is read live, so an operator revocation applies at once.
      const { rows } = await withClient((client) => client.query<{ user_id: string; email: string; csrf_token: string; is_organiser: boolean }>(
        `SELECT s.user_id, s.email, s.csrf_token, u.is_organiser
           FROM identity.sessions s JOIN identity.users u ON u.id = s.user_id
          WHERE s.token_hash = $1 AND s.expires_at > clock_timestamp()`, [tokenHash(token)]));
      const row = rows[0];
      return row ? { id: row.user_id, email: row.email, isOrganiser: row.is_organiser, csrfToken: row.csrf_token } : null;
    },
    establish: async (identity, previousToken) => withClient(async (client) => {
      const token = randomToken();
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL statement_timeout = '2s'");
        if (previousToken && TOKEN.test(previousToken)) {
          await client.query("DELETE FROM identity.sessions WHERE token_hash = $1", [tokenHash(previousToken)]);
        }
        const { rows } = await client.query<{ id: string }>(
          "SELECT identity.upsert_verified_user($1, $2, $3) AS id", [identity.issuer, identity.subject, identity.email]);
        await client.query(
          `INSERT INTO identity.sessions(token_hash, user_id, email, csrf_token, expires_at)
           VALUES ($1, $2, $3, $4, clock_timestamp() + make_interval(secs => $5))`,
          [tokenHash(token), rows[0].id, identity.email, randomToken(), SESSION_SECONDS]);
        await client.query("COMMIT");
      } catch (cause) {
        await client.query("ROLLBACK").catch(() => {});
        throw cause;
      }
      return { token, maxAgeSeconds: SESSION_SECONDS };
    }),
    revoke: async (token) => {
      if (!TOKEN.test(token)) return;
      await withClient((client) => client.query("DELETE FROM identity.sessions WHERE token_hash = $1", [tokenHash(token)]));
    },
  };
}
