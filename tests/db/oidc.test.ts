// SPEC.md §5 Google OIDC and portal sessions, scenarios 1, 2 and 4. A local test
// IdP signs RS256 ID tokens; the token endpoint is stubbed. No real Google
// account, client secret or token is used.
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, createHmac, type KeyObject } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, expect, inject, test } from "vitest";
import { createApp } from "../../services/portal-api/src/index";
import { createSessionStore } from "../../services/portal-api/src/auth";
import { migrateFoundation, rollbackFoundation } from "../../services/portal-api/src/migrate";

const url = inject("testDatabaseUrl"), origin = "https://portal.feedback.test:4173";
const clientId = "test-client.apps.googleusercontent.com";
const redirectUri = `${origin}/api/v1/auth/callback`;
const signer = generateKeyPairSync("rsa", { modulusLength: 2048 });
const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 });
const certs = { "kid-1": signer.publicKey.export({ type: "spki", format: "pem" }) as string };
const observer = new Client({ connectionString: url });
let app: ReturnType<typeof createApp>;
let issued: Record<string, unknown> = {};
let header: Record<string, unknown> = { alg: "RS256", kid: "kid-1", typ: "JWT" };
let signingKey: KeyObject = signer.privateKey;
let exchanged: { code: string; verifier: string }[] = [];

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
function idToken(claims: Record<string, unknown>): string {
  const data = `${b64(header)}.${b64(claims)}`;
  const signature = header.alg === "HS256" ? createHmac("sha256", "guess").update(data).digest()
    : sign("sha256", Buffer.from(data), signingKey);
  return `${data}.${signature.toString("base64url")}`;
}
const now = () => Math.floor(Date.now() / 1000);
const goodClaims = (nonce: string, overrides: Record<string, unknown> = {}) => ({
  iss: "https://accounts.google.com", aud: clientId, azp: clientId, sub: "1001", email: "Alice@IITGN.ac.in",
  email_verified: true, hd: "iitgn.ac.in", iat: now(), exp: now() + 3600, nonce, ...overrides,
});

beforeAll(async () => {
  await migrateFoundation(url);
  await observer.connect();
  const lease = async () => {
    const client = new Client({ connectionString: url });
    await client.connect();
    await client.query("SET ROLE feedback_auth");
    return { client, release: () => client.end() };
  };
  const store = createSessionStore(lease);
  app = createApp({ origin, keyDirectory: "/nonexistent", encryptionKey: randomBytes(32), cursorKey: randomBytes(32),
    authenticate: store.authenticate,
    acquireClient: async () => { throw new Error("portal admin pool unused in this test"); },
    auth: { store, acquireClient: lease, oidc: { clientId, clientSecret: "test-secret", redirectUri, domain: "iitgn.ac.in",
      certs: async () => certs,
      exchangeCode: async (code: string, verifier: string) => {
        exchanged.push({ code, verifier });
        return { id_token: idToken(issued), access_token: "discard-me", token_type: "Bearer" };
      } } },
  });
});
afterAll(async () => { await app?.close(); await observer.end(); await rollbackFoundation(url); });

const cookieValue = (setCookie: string | string[] | undefined, name: string) => {
  const all = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const line = all.find((entry) => entry.startsWith(`${name}=`));
  return line ? { line, value: line.slice(name.length + 1).split(";")[0] } : undefined;
};
async function begin(returnTo = "/") {
  const response = await app.inject({ method: "GET", url: `/api/v1/auth/login?returnTo=${encodeURIComponent(returnTo)}` });
  expect(response.statusCode).toBe(302);
  const location = new URL(response.headers.location as string);
  const preauth = cookieValue(response.headers["set-cookie"], "__Host-preauth")!;
  return { response, location, preauth, state: location.searchParams.get("state")!, nonce: location.searchParams.get("nonce")! };
}
async function callback(state: string, cookie: string | undefined, extra = "") {
  return app.inject({ method: "GET", url: `/api/v1/auth/callback?state=${encodeURIComponent(state)}&code=4%2Fcode-${randomUUID()}&scope=email%20openid&authuser=0&hd=iitgn.ac.in&prompt=none${extra}`,
    headers: cookie ? { cookie } : {} });
}
async function login(claims: (nonce: string) => Record<string, unknown>, existingSession?: string) {
  const flow = await begin();
  issued = claims(flow.nonce);
  const done = await callback(flow.state, [`__Host-preauth=${flow.preauth.value}`, existingSession && `__Host-session=${existingSession}`].filter(Boolean).join("; "));
  return { flow, done, session: cookieValue(done.headers["set-cookie"], "__Host-session") };
}
const sessionCount = async () => Number((await observer.query("SELECT count(*) FROM identity.sessions")).rows[0].count);

test("authorization request uses code flow, PKCE S256, separate 256-bit state/nonce and a bound host-only pre-auth cookie", async () => {
  const { response, location, preauth, state, nonce } = await begin("/signed-in");
  expect(`${location.origin}${location.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
  const params = Object.fromEntries(location.searchParams);
  expect(Object.keys(params).sort()).toEqual(["client_id", "code_challenge", "code_challenge_method", "hd", "nonce", "prompt", "redirect_uri", "response_type", "scope", "state"].sort());
  expect(params).toMatchObject({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: "openid email", code_challenge_method: "S256", hd: "iitgn.ac.in" });
  for (const value of [state, nonce, preauth.value]) expect(Buffer.from(value, "base64url")).toHaveLength(32);
  expect(new Set([state, nonce, preauth.value]).size).toBe(3);
  expect(preauth.line).toMatch(/^__Host-preauth=[A-Za-z0-9_-]{43}; Secure; HttpOnly; SameSite=Lax; Path=\/; Max-Age=600$/);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers["referrer-policy"]).toBe("no-referrer");
  const row = (await observer.query("SELECT * FROM identity.oauth_transactions")).rows.at(-1);
  expect(row.return_path).toBe("/signed-in");
  expect(row.state_hash.equals(createHash("sha256").update(state).digest())).toBe(true);
  expect(JSON.stringify(row)).not.toContain(state);
  expect(JSON.stringify(row)).not.toContain(preauth.value);
  for (const unsafe of ["//evil.example", "https://evil.example/", "/\\evil.example", "/api/v1/session", "javascript:alert(1)", "/claim-bridge?pollId=x", ""]) {
    const refused = await app.inject({ method: "GET", url: `/api/v1/auth/login?returnTo=${encodeURIComponent(unsafe)}` });
    expect(refused.statusCode, unsafe).toBe(400);
    expect(refused.headers["set-cookie"], unsafe).toBeUndefined();
  }
  expect((await app.inject({ method: "GET", url: "/api/v1/auth/login?returnTo=/&returnTo=/" })).statusCode).toBe(400);
});

test("a valid institutional ID token establishes a hashed, host-only, eight-hour session and a clean redirect", async () => {
  const { flow, done, session } = await login((nonce) => goodClaims(nonce));
  expect(done.statusCode).toBe(302);
  expect(done.headers.location).toBe("/");
  expect(done.headers["cache-control"]).toBe("no-store");
  expect(done.headers["referrer-policy"]).toBe("no-referrer");
  expect(session!.line).toMatch(/^__Host-session=[A-Za-z0-9_-]{43}; Secure; HttpOnly; SameSite=Lax; Path=\/; Max-Age=28800$/);
  expect(cookieValue(done.headers["set-cookie"], "__Host-preauth")!.line).toContain("Max-Age=0");
  const verifier = exchanged.at(-1)!.verifier;
  expect(createHash("sha256").update(verifier).digest("base64url")).toBe(flow.location.searchParams.get("code_challenge"));
  const me = await app.inject({ method: "GET", url: "/api/v1/session", headers: { cookie: `__Host-session=${session!.value}` } });
  expect(me.statusCode).toBe(200);
  expect(me.json()).toMatchObject({ user: { email: "alice@iitgn.ac.in", isOrganiser: false } });
  expect(Buffer.from(me.json().csrfToken, "base64url")).toHaveLength(32);
  const rows = (await observer.query("SELECT s.*, u.issuer, u.subject FROM identity.sessions s JOIN identity.users u ON u.id=s.user_id")).rows;
  const stored = rows.find((row) => row.token_hash.equals(createHash("sha256").update(session!.value).digest()));
  expect(stored).toBeDefined();
  expect(JSON.stringify(rows)).not.toContain(session!.value);
  expect([stored.issuer, stored.subject]).toEqual(["https://accounts.google.com", "1001"]);
  const lifetime = (await observer.query("SELECT extract(epoch FROM expires_at - clock_timestamp()) AS s FROM identity.sessions WHERE token_hash=$1", [stored.token_hash])).rows[0].s;
  expect(Number(lifetime)).toBeGreaterThan(8 * 3600 - 60);
  expect(Number(lifetime)).toBeLessThanOrEqual(8 * 3600);
  expect((await observer.query("SELECT count(*) FROM identity.oauth_transactions WHERE state_hash=$1", [createHash("sha256").update(flow.state).digest()])).rows[0].count).toBe("0");
  // Reused state cannot establish another session.
  const before = await sessionCount();
  const reused = await callback(flow.state, `__Host-preauth=${flow.preauth.value}`);
  expect([reused.statusCode, reused.headers.location]).toEqual([302, "/?signin=failed"]);
  expect(cookieValue(reused.headers["set-cookie"], "__Host-session")).toBeUndefined();
  expect(await sessionCount()).toBe(before);
  expect(JSON.stringify(done.headers)).not.toMatch(/4%2Fcode|4\/code|discard-me/);
});

test("issuer/subject identity is stable across email changes; login rotates the session; logout needs CSRF", async () => {
  const first = await login((nonce) => goodClaims(nonce, { sub: "2002", email: "old.name@iitgn.ac.in" }));
  const id = (await app.inject({ method: "GET", url: "/api/v1/session", headers: { cookie: `__Host-session=${first.session!.value}` } })).json().user.id;
  const second = await login((nonce) => goodClaims(nonce, { sub: "2002", email: "new.name@iitgn.ac.in", iss: "accounts.google.com" }), first.session!.value);
  const me = (await app.inject({ method: "GET", url: "/api/v1/session", headers: { cookie: `__Host-session=${second.session!.value}` } })).json();
  expect(me.user).toEqual({ id, email: "new.name@iitgn.ac.in", isOrganiser: false });
  expect((await observer.query("SELECT issuer, email FROM identity.users WHERE id=$1", [id])).rows[0])
    .toEqual({ issuer: "https://accounts.google.com", email: "new.name@iitgn.ac.in" });
  expect((await app.inject({ method: "GET", url: "/api/v1/session", headers: { cookie: `__Host-session=${first.session!.value}` } })).statusCode).toBe(401);
  const cookie = `__Host-session=${second.session!.value}`;
  const logout = (headers: Record<string, string>, payload = "{}") =>
    app.inject({ method: "POST", url: "/api/v1/auth/logout", payload, headers: { cookie, "content-type": "application/json", ...headers } });
  expect((await logout({ origin, "x-csrf-token": "wrong" })).statusCode).toBe(403);
  expect((await logout({ origin: "https://respond.feedback.test:4174", "x-csrf-token": me.csrfToken })).statusCode).toBe(403);
  const out = await logout({ origin, "x-csrf-token": me.csrfToken });
  expect(out.statusCode).toBe(204);
  expect(cookieValue(out.headers["set-cookie"], "__Host-session")!.line).toContain("Max-Age=0");
  expect((await app.inject({ method: "GET", url: "/api/v1/session", headers: { cookie } })).statusCode).toBe(401);
  // Absolute expiry is enforced by the stored deadline, not the cookie.
  const third = await login((nonce) => goodClaims(nonce, { sub: "2002", email: "new.name@iitgn.ac.in" }));
  await observer.query("UPDATE identity.sessions SET expires_at = clock_timestamp() - interval '1 second' WHERE token_hash=$1",
    [createHash("sha256").update(third.session!.value).digest()]);
  expect((await app.inject({ method: "GET", url: "/api/v1/session", headers: { cookie: `__Host-session=${third.session!.value}` } })).statusCode).toBe(401);
});

test("every ID-token, transaction and login-CSRF failure is refused without a session", async () => {
  const cases: [string, (nonce: string) => Record<string, unknown>, (() => void)?][] = [
    ["wrong issuer", (n) => goodClaims(n, { iss: "https://evil.example" })],
    ["wrong audience", (n) => goodClaims(n, { aud: "other.apps.googleusercontent.com" })],
    ["multiple audiences", (n) => goodClaims(n, { aud: [clientId, "other"] })],
    ["azp for another client", (n) => goodClaims(n, { azp: "other.apps.googleusercontent.com" })],
    ["expired", (n) => goodClaims(n, { iat: now() - 7200, exp: now() - 120 })],
    ["iat in the future beyond skew", (n) => goodClaims(n, { iat: now() + 120 })],
    ["nonce mismatch", (n) => goodClaims(`${n}x`)],
    ["missing hd", (n) => { const c: Record<string, unknown> = goodClaims(n); delete c.hd; return c; }],
    ["wrong hd", (n) => goodClaims(n, { hd: "gmail.com" })],
    ["hd suffix", (n) => goodClaims(n, { hd: "student.iitgn.ac.in" })],
    ["unverified email", (n) => goodClaims(n, { email_verified: false })],
    ["string email_verified", (n) => goodClaims(n, { email_verified: "true" })],
    ["non-institutional email", (n) => goodClaims(n, { email: "alice@gmail.com" })],
    ["subdomain email", (n) => goodClaims(n, { email: "alice@mail.iitgn.ac.in" })],
    ["empty subject", (n) => goodClaims(n, { sub: "" })],
    ["signed by another key", (n) => goodClaims(n), () => { signingKey = stranger.privateKey; }],
    ["HS256 header", (n) => goodClaims(n), () => { header = { alg: "HS256", kid: "kid-1", typ: "JWT" }; }],
    ["unknown key id", (n) => goodClaims(n), () => { header = { alg: "RS256", kid: "kid-2", typ: "JWT" }; }],
  ];
  for (const [name, claims, arrange] of cases) {
    header = { alg: "RS256", kid: "kid-1", typ: "JWT" }; signingKey = signer.privateKey;
    arrange?.();
    const before = await sessionCount();
    const { done, session } = await login(claims);
    expect([done.statusCode, done.headers.location], name).toEqual([302, "/?signin=failed"]);
    expect(session, name).toBeUndefined();
    expect(await sessionCount(), name).toBe(before);
    expect(done.body, name).toBe("");
  }
  header = { alg: "RS256", kid: "kid-1", typ: "JWT" }; signingKey = signer.privateKey;
  // Login CSRF: a callback without, or with a different, pre-auth binding fails and burns the state.
  for (const cookie of [undefined, `__Host-preauth=${randomBytes(32).toString("base64url")}`]) {
    const flow = await begin();
    issued = goodClaims(flow.nonce);
    const exchangesBefore = exchanged.length;
    const forged = await callback(flow.state, cookie);
    expect([forged.statusCode, forged.headers.location]).toEqual([302, "/?signin=failed"]);
    expect(exchanged.length).toBe(exchangesBefore);
    expect((await callback(flow.state, `__Host-preauth=${flow.preauth.value}`)).headers.location).toBe("/?signin=failed");
  }
  // An expired transaction is refused even with the right binding.
  const flow = await begin();
  issued = goodClaims(flow.nonce);
  await observer.query("UPDATE identity.oauth_transactions SET expires_at = clock_timestamp() - interval '1 second' WHERE state_hash=$1",
    [createHash("sha256").update(flow.state).digest()]);
  expect((await callback(flow.state, `__Host-preauth=${flow.preauth.value}`)).headers.location).toBe("/?signin=failed");
  // Provider errors and malformed callbacks also fail closed.
  const errored = await app.inject({ method: "GET", url: "/api/v1/auth/callback?error=access_denied&state=x" });
  expect([errored.statusCode, errored.headers.location]).toEqual([302, "/?signin=failed"]);
  const flow2 = await begin();
  issued = goodClaims(flow2.nonce);
  const extra = await callback(flow2.state, `__Host-preauth=${flow2.preauth.value}`, "&token=leak");
  expect(extra.headers.location).toBe("/?signin=failed");
});
