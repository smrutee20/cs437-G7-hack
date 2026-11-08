import Fastify, { type FastifyReply, type FastifyRequest, type FastifyServerFactory } from "fastify";
import { isCanonicalUuidV4, parseStrictJson } from "@iitgn-feedback/protocol";
import type { Client } from "pg";
import { createKeyedBuckets, createSemaphore, createTokenBucket, Overloaded, type Admission } from "./admission.js";
import { RedeemError, redeemResponse } from "./redeem.js";

// The response service receives a dedicated public DB role. No portal sessions,
// private-key store, identity connection, or cookies are configured here, and
// it never sets a cookie or logs a request.
type Config = {
  /** Exact response origin. Browser submissions must carry it; non-browser clients may omit Origin. */
  origin: string;
  acquireClient: () => Promise<{ client: Client; release: () => Promise<void> }>;
  /** Admission clock; tests freeze it. Defaults to Date.now. */
  now?: () => number;
  /** Production HTTPS server with request bounds and ingress stripping (packages/http). */
  serverFactory?: FastifyServerFactory;
};
class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
const body = (code: string, extra: Record<string, unknown> = {}) =>
  ({ error: { code, message: code.replaceAll("_", " "), ...extra } });
const STATUS: Record<string, number> = {
  invalid_request: 400, invalid_credential: 400, not_found: 404, validation_failed: 422, credential_spent: 409,
  poll_closed: 410, poll_withdrawn: 410, temporarily_unavailable: 503,
};

export function createApp(config: Config) {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024, ...(config.serverFactory ? { serverFactory: config.serverFactory } : {}) });
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, raw, done) => {
    try { done(null, parseStrictJson(raw as Buffer)); }
    catch { done(new HttpError(400, "invalid_request")); }
  });
  // SPEC.md §14 public-side limits, keyed by route class or public poll ID only.
  const now = config.now ?? Date.now;
  const reads = createTokenBucket({ ratePerSecond: 100, burst: 200, now });
  const submissions = createTokenBucket({ ratePerSecond: 20, burst: 40, now });
  const perPoll = createKeyedBuckets({ ratePerSecond: 5, burst: 10, idleMs: 600_000, now });
  const verification = createSemaphore({ concurrent: 4, queue: 20, waitMs: 2000 });
  const limited = (reply: FastifyReply, decision: Admission) => {
    if (decision.allowed) return false;
    void reply.code(429).header("Retry-After", String(decision.retryAfterSeconds)).send(body("rate_limited"));
    return true;
  };

  app.addHook("onRequest", async (_req, reply) => { reply.header("Cache-Control", "no-store"); });
  app.setErrorHandler((cause, _req, reply) => {
    let status = 500, code = "internal_error", extra: Record<string, unknown> = {};
    if (cause instanceof RedeemError) {
      code = cause.code; status = STATUS[code] ?? 503;
      if (cause.field) extra = { field: cause.field };
    } else if (cause instanceof HttpError) ({ status, code } = cause);
    else if (cause instanceof Overloaded) { status = 503; code = "capacity_unavailable"; }
    else if (cause && typeof cause === "object" && "statusCode" in cause) {
      if (cause.statusCode === 413) { status = 413; code = "payload_too_large"; }
      else if (cause.statusCode === 415) { status = 415; code = "unsupported_media_type"; }
      else if (cause.statusCode === 400) { status = 400; code = "invalid_request"; }
    }
    // No credential, answer, exception detail or request metadata in errors.
    return reply.code(status).send(body(code, extra));
  });

  app.get<{ Params: { id: string } }>("/api/v1/polls/:id/public", {
    onRequest: async (_req, reply) => { if (limited(reply, reads.take())) return reply; },
  }, async (req, reply) => {
    if (!isCanonicalUuidV4(req.params.id)) return reply.code(404).send(body("not_found"));
    const { client, release } = await config.acquireClient();
    try {
      const { rows } = await client.query(
        `SELECT id,title,description,state,invalidated,opened_at,closed_at,closes_at,questions,
                policy_version,key_id,key_version,suite,public_jwk
           FROM public_polls WHERE id=$1`, [req.params.id],
      );
      if (!rows[0]) return reply.code(404).send(body("not_found"));
      const p = rows[0];
      return {
        id: p.id, title: p.title, description: p.description, status: p.state, invalidated: p.invalidated,
        openedAt: p.opened_at.toISOString(), closedAt: p.closed_at?.toISOString() ?? null,
        closesAt: p.closes_at.toISOString(), questions: p.questions,
        policy: { version: p.policy_version, minEligible: 10, minResponses: 5, minAnswersPerQuestion: 5 },
        key: { keyId: p.key_id, keyVersion: p.key_version, suite: p.suite, modulusBits: 3072, publicJwk: p.public_jwk },
      };
    } finally { await release(); }
  });

  // Everything that can be decided from headers runs before the body is read or parsed.
  const admitSubmission = async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== "" && origin !== config.origin) return reply.code(403).send(body("forbidden"));
    if (req.url.includes("?")) return reply.code(400).send(body("invalid_request")); // never accept credentials in URLs
    const encoding = req.headers["content-encoding"];
    if ((encoding !== undefined && encoding !== "identity") ||
        req.headers["content-type"]?.split(";")[0].trim() !== "application/json") {
      return reply.code(415).send(body("unsupported_media_type"));
    }
    if (limited(reply, submissions.take()) || limited(reply, perPoll.take(req.params.id))) return reply;
  };
  app.post<{ Params: { id: string } }>("/api/v1/polls/:id/responses", { onRequest: admitSubmission }, async (req, reply) => {
    let lease: { client: Client; release: () => Promise<void> };
    try { lease = await config.acquireClient(); }
    catch { throw new RedeemError("temporarily_unavailable"); }
    try {
      const { status } = await redeemResponse(lease.client, req.params.id, req.body,
        { verify: (task) => verification.run(task) });
      return reply.code(status).send({ status: "accepted" });
    } finally {
      await lease.release().catch(() => {});
    }
  });
  return app;
}
