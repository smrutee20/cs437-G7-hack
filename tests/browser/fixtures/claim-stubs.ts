// Synthetic poll APIs for the two-origin browser suite. No backend runs here:
// Playwright fulfils the same-origin API calls each app makes, and the claim
// stub signs with an independent OpenSSL raw private operation in Node.
import { randomUUID, type KeyObject } from "node:crypto";
import type { BrowserContext, Request } from "@playwright/test";
import { localOrigins } from "../../../packages/config/src/local-dev.js";
import { freshKey, nodeRawSign } from "../../fixtures/rsa";

const origins = localOrigins();
export const portal = origins.portal.origin;
export const respond = origins.respond.origin;
export const CSRF = "synthetic-csrf-token";
export const PARTICIPANT = "synthetic-participant@iitgn.ac.in";

let cachedKey: ReturnType<typeof freshKey> | undefined;
export type SyntheticPoll = {
  pollId: string; keyId: string; title: string; privateKey: KeyObject;
  publicJwk: { kty: "RSA"; n: string; e: "AQAB" }; dto: Record<string, unknown>;
};
export function syntheticPoll(overrides: { pollId?: string; key?: ReturnType<typeof freshKey> } = {}): SyntheticPoll {
  const key = overrides.key ?? (cachedKey ??= freshKey());
  const pollId = overrides.pollId ?? randomUUID(), keyId = randomUUID(), title = "Synthetic claim poll";
  const publicJwk = { kty: "RSA" as const, n: key.jwk.n as string, e: "AQAB" as const };
  return { pollId, keyId, title, privateKey: key.privateKey, publicJwk, dto: {
    id: pollId, title, description: "Synthetic browser fixture", status: "open", invalidated: false,
    openedAt: new Date(Date.now() - 60_000).toISOString(), closedAt: null,
    closesAt: new Date(Date.now() + 86_400_000).toISOString(),
    questions: [{ id: randomUUID(), type: "rating", prompt: "How was it?", required: true }],
    policy: { version: 1, minEligible: 10, minResponses: 5, minAnswersPerQuestion: 5 },
    key: { keyId, keyVersion: 1, suite: "RSABSSA-SHA384-PSS-Randomized", modulusBits: 3072, publicJwk },
  } };
}

export type ClaimCall = { headers: Record<string, string>; body: unknown; url: string };
export type StubOptions = {
  signedIn?: boolean;
  /** Replaces the default 201 signing behaviour. Return null to abort the connection. */
  claim?: (body: { keyId: string; keyVersion: number; blindedMessage: string }, poll: SyntheticPoll) =>
    { status: number; body: unknown } | null;
};

const json = (status: number, body: unknown) =>
  ({ status, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify(body) });

export async function stubApis(context: BrowserContext, poll: SyntheticPoll, options: StubOptions = {}) {
  const calls: ClaimCall[] = [];
  const signedIn = options.signedIn ?? true;
  await context.route(`${respond}/api/v1/polls/${poll.pollId}/public`, (route) => route.fulfill(json(200, poll.dto)));
  await context.route(`${portal}/api/v1/polls/${poll.pollId}/claim-context`, (route) =>
    route.fulfill(signedIn ? json(200, poll.dto) : json(401, { error: { code: "authentication_required", message: "authentication required" } })));
  await context.route(`${portal}/api/v1/session`, (route) =>
    route.fulfill(signedIn
      ? json(200, { user: { id: randomUUID(), email: PARTICIPANT, isOrganiser: false }, csrfToken: CSRF })
      : json(401, { error: { code: "authentication_required", message: "authentication required" } })));
  await context.route(`${portal}/api/v1/polls/${poll.pollId}/claim`, async (route) => {
    const request: Request = route.request();
    const body = request.postDataJSON();
    calls.push({ headers: await request.allHeaders(), body, url: request.url() });
    const outcome = options.claim ? options.claim(body, poll) : {
      status: 201,
      body: { blindSignature: Buffer.from(nodeRawSign(poll.privateKey,
        Buffer.from(body.blindedMessage, "base64url"))).toString("base64url") },
    };
    if (outcome === null) return route.abort("connectionreset");
    return route.fulfill(json(outcome.status, outcome.body));
  });
  return { calls };
}
