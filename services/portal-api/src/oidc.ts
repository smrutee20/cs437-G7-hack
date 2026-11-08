// Server-side Google OIDC authorization-code flow (SPEC.md §5). PKCE S256, a
// 256-bit state bound to a 256-bit __Host-preauth cookie and a single-use
// server-side transaction, and a separate 256-bit nonce. Signature, issuer,
// audience and lifetime are verified by google-auth-library (pinned); the
// stricter institutional checks below are layered on top. Nothing here logs:
// the library's own error messages embed the raw JWT, so they are discarded.
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { OAuth2Client } from "google-auth-library";
import {
  clearedCookie, hostCookie, PREAUTH_COOKIE, randomToken, readTokenCookie, sameToken, SESSION_COOKIE, tokenHash,
  type Lease, type SessionStore, type VerifiedIdentity,
} from "./auth.js";

export type OidcConfig = {
  clientId: string;
  clientSecret: string;
  /** Exact registered portal callback URI. */
  redirectUri: string;
  /** Institutional email domain and the expected signed `hd` claim (both iitgn.ac.in in production). */
  domain: string;
  /** Tests inject a local IdP's keys; production fetches Google's rotating certificates. */
  certs?: () => Promise<Record<string, string>>;
  /** Tests stub the token endpoint; production posts to Google with the PKCE verifier. */
  exchangeCode?: (code: string, verifier: string) => Promise<unknown>;
};

export const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const ISSUERS = ["accounts.google.com", "https://accounts.google.com"];
const SKEW_SECONDS = 60;
const TRANSACTION_SECONDS = 600;
/** Only these relative portal paths may follow sign-in. The claim bridge never does. */
export const RETURN_PATHS = new Set(["/", "/signed-in"]);
const CALLBACK_PARAMS = new Set(["code", "state", "scope", "authuser", "hd", "prompt", "iss"]);
const LOCAL_PART = /^(?!\.)(?!.*\.\.)(?!.*\.$)[a-z0-9._+-]{1,64}$/;

export class OidcError extends Error {
  constructor() { super("sign-in failed"); }
}

function decodeSegment(segment: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new OidcError();
  const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OidcError();
  return value as Record<string, unknown>;
}

/** Verifies a Google ID token against SPEC.md §5 and returns only the fields the application keeps. */
export async function verifyGoogleIdToken(idToken: unknown, options: {
  clientId: string; nonce: string; domain: string; certs: Record<string, string>; nowSeconds?: number;
}): Promise<VerifiedIdentity> {
  if (typeof idToken !== "string" || idToken.length > 8192) throw new OidcError();
  const segments = idToken.split(".");
  if (segments.length !== 3) throw new OidcError();
  let header: Record<string, unknown>, claims: Record<string, unknown>;
  try { header = decodeSegment(segments[0]); claims = decodeSegment(segments[1]); }
  catch { throw new OidcError(); }
  // RS256 only: no `none`, HMAC or other algorithms, and a known Google key ID.
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !Object.hasOwn(options.certs, header.kid)) throw new OidcError();
  try {
    await new OAuth2Client({ clientId: options.clientId })
      .verifySignedJwtWithCertsAsync(idToken, options.certs, options.clientId, ISSUERS);
  } catch {
    throw new OidcError(); // the library's message contains the token; never surface it
  }
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const { iss, aud, azp, exp, iat, nonce, sub, email, email_verified: verified, hd } = claims;
  if (typeof iss !== "string" || !ISSUERS.includes(iss)) throw new OidcError();
  if (typeof aud !== "string" || aud !== options.clientId) throw new OidcError();
  if (azp !== undefined && azp !== options.clientId) throw new OidcError();
  if (typeof exp !== "number" || !Number.isFinite(exp) || exp + SKEW_SECONDS <= now) throw new OidcError();
  if (typeof iat !== "number" || !Number.isFinite(iat) || iat > now + SKEW_SECONDS) throw new OidcError();
  if (typeof nonce !== "string" || !sameToken(nonce, options.nonce)) throw new OidcError();
  if (typeof sub !== "string" || sub.length === 0 || sub.length > 255) throw new OidcError();
  if (verified !== true) throw new OidcError();
  // The signed hosted-domain claim is the institutional evidence; the email suffix alone is not.
  if (hd !== options.domain) throw new OidcError();
  if (typeof email !== "string" || /[^\x21-\x7e]/.test(email)) throw new OidcError();
  const normalized = email.toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at < 1 || normalized.indexOf("@") !== at || normalized.slice(at + 1) !== options.domain ||
      !LOCAL_PART.test(normalized.slice(0, at)) || normalized.length > 254) throw new OidcError();
  return { issuer: "https://accounts.google.com", subject: sub, email: normalized };
}

async function exchangeWithGoogle(config: OidcConfig, code: string, verifier: string): Promise<unknown> {
  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: config.clientId, client_secret: config.clientSecret,
      redirect_uri: config.redirectUri, grant_type: "authorization_code", code_verifier: verifier }),
  });
  if (!response.ok) throw new OidcError();
  return response.json();
}

function strictQuery(url: string, allowed: Set<string>): Map<string, string> | null {
  const query = url.indexOf("?") === -1 ? "" : url.slice(url.indexOf("?") + 1);
  const params = new URLSearchParams(query), out = new Map<string, string>();
  for (const [key, value] of params) {
    if (!allowed.has(key) || out.has(key) || value.length > 2048) return null;
    out.set(key, value);
  }
  return out;
}

/** GET /auth/login and GET /auth/callback. Both are exempt from the session preHandler. */
export function registerOidcRoutes(app: FastifyInstance, { oidc, acquireClient, store }: {
  oidc: OidcConfig; acquireClient: Lease; store: SessionStore;
}): void {
  const google = new OAuth2Client({ clientId: oidc.clientId });
  const certs = oidc.certs ?? (async () => (await google.getFederatedSignonCertsAsync()).certs as Record<string, string>);
  const exchange = oidc.exchangeCode ?? ((code: string, verifier: string) => exchangeWithGoogle(oidc, code, verifier));
  const noStore = (reply: FastifyReply) => reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer");
  const failed = (reply: FastifyReply) =>
    noStore(reply).header("Set-Cookie", clearedCookie(PREAUTH_COOKIE)).redirect("/?signin=failed", 302);

  app.get("/api/v1/auth/login", { config: { public: true } }, async (req, reply) => {
    noStore(reply);
    const query = strictQuery(req.url, new Set(["returnTo"]));
    const returnTo = query?.get("returnTo") ?? (query?.size === 0 ? "/" : undefined);
    if (!query || returnTo === undefined || !RETURN_PATHS.has(returnTo)) {
      return reply.code(400).send({ error: { code: "invalid_request", message: "invalid request" } });
    }
    const state = randomToken(), nonce = randomToken(), verifier = randomToken(), preauth = randomToken();
    const { client, release } = await acquireClient();
    try {
      await client.query(
        `INSERT INTO identity.oauth_transactions(state_hash, preauth_hash, nonce, pkce_verifier, return_path, expires_at)
         VALUES ($1, $2, $3, $4, $5, clock_timestamp() + make_interval(secs => $6))`,
        [tokenHash(state), tokenHash(preauth), nonce, verifier, returnTo, TRANSACTION_SECONDS]);
    } finally { await release(); }
    const target = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
    target.search = new URLSearchParams({
      client_id: oidc.clientId, redirect_uri: oidc.redirectUri, response_type: "code", scope: "openid email",
      state, nonce, code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256", hd: oidc.domain, prompt: "select_account",
    }).toString();
    return reply.header("Set-Cookie", hostCookie(PREAUTH_COOKIE, preauth, TRANSACTION_SECONDS)).redirect(target.href, 302);
  });

  app.get("/api/v1/auth/callback", { config: { public: true } }, async (req, reply) => {
    // The one-time code and state may appear only here; respond with a clean redirect and no body.
    const query = strictQuery(req.url, CALLBACK_PARAMS);
    const code = query?.get("code"), state = query?.get("state");
    if (!query || !code || !state || !/^[A-Za-z0-9_-]{43}$/.test(state)) return failed(reply);
    const { client, release } = await acquireClient();
    let transaction: { preauth_hash: Buffer; nonce: string; pkce_verifier: string; return_path: string } | undefined;
    try {
      // Single use: the transaction is deleted whether or not the rest succeeds.
      transaction = (await client.query(
        `DELETE FROM identity.oauth_transactions WHERE state_hash = $1
         RETURNING preauth_hash, nonce, pkce_verifier, return_path, expires_at > clock_timestamp() AS live`,
        [tokenHash(state)])).rows.find((row) => row.live);
    } finally { await release(); }
    const preauth = readTokenCookie(req.headers.cookie, PREAUTH_COOKIE);
    if (!transaction || !preauth || !tokenHash(preauth).equals(transaction.preauth_hash)) return failed(reply);
    let identity: VerifiedIdentity;
    try {
      const tokens = await exchange(code, transaction.pkce_verifier);
      const idToken = tokens && typeof tokens === "object" ? (tokens as { id_token?: unknown }).id_token : undefined;
      // Access tokens are discarded unread; no refresh token is ever requested.
      identity = await verifyGoogleIdToken(idToken, { clientId: oidc.clientId, nonce: transaction.nonce,
        domain: oidc.domain, certs: await certs() });
    } catch {
      return failed(reply);
    }
    const session = await store.establish(identity, readTokenCookie(req.headers.cookie, SESSION_COOKIE));
    return noStore(reply)
      .header("Set-Cookie", [hostCookie(SESSION_COOKIE, session.token, session.maxAgeSeconds), clearedCookie(PREAUTH_COOKIE)])
      .redirect(transaction.return_path, 302);
  });
}
