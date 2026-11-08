import Fastify, { type FastifyRequest } from "fastify";
import type { Client } from "pg";
import { isCanonicalUuidV4, parseStrictJson } from "@iitgn-feedback/protocol";
import { createDraft } from "./create-draft.js";
import { deleteDraft } from "./delete-draft.js";
import { DraftValidationError } from "./draft.js";
import { closePoll, openPoll, PollError, updateDraft } from "./poll-lifecycle.js";
import { makeCursor, readCursor } from "./cursor.js";
import { createSigningCapacity } from "./capacity.js";
import { ClaimError, issueClaim, type ClaimErrorCode } from "./claim.js";
import { loadPrivateKey } from "./keys.js";
import { readResults } from "./results.js";
import { createAccountLimiter } from "./rate-limit.js";
import type { SignerClient } from "./signer-client.js";
import { clearedCookie, readTokenCookie, SESSION_COOKIE, type Lease, type SessionStore } from "./auth.js";
import { registerOidcRoutes, type OidcConfig } from "./oidc.js";

type Session = { id: string; email?: string; isOrganiser: boolean; csrfToken: string };
type Config = {
  origin: string;
  keyDirectory: string;
  encryptionKey: Buffer;
  cursorKey: Buffer;
  authenticate: (request: FastifyRequest) => Promise<Session | null>;
  acquireClient: () => Promise<{client: Client; release: () => Promise<void>}>;
  /** Separate feedback_issuer pool and private signer. Without it, no claim route exists. */
  issuer?: {
    acquireClient: () => Promise<{client: Client; release: () => Promise<void>}>;
    signer: SignerClient;
  };
  /** Production sign-in: server-side session store plus Google OIDC routes. */
  auth?: { store: SessionStore; acquireClient: Lease; oidc?: OidcConfig };
};
const CLAIM_STATUS: Record<ClaimErrorCode, number> = {
  invalid_request:400, not_found:404, not_eligible:403, claim_consumed:409, poll_closed:410, poll_withdrawn:410,
  capacity_unavailable:503, claim_consumed_no_credential:503, temporarily_unavailable:503,
};
class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
const error = (code: string) => ({error:{code,message:code.replaceAll("_"," ")}});
function fields(body: unknown, names: string[]): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).length !== names.length || !names.every((name)=>Object.hasOwn(body,name))) {
    throw new ApiError(400,"invalid_request");
  }
  return body as Record<string,unknown>;
}
function revision(body: unknown): number {
  const value=fields(body,["revision"]).revision;
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 1) throw new ApiError(400,"invalid_request");
  return value;
}

export function createApp(config: Config) {
  if (!Buffer.isBuffer(config.cursorKey) || config.cursorKey.length !== 32) throw new Error("cursor key unavailable");
  const app = Fastify({logger:false, bodyLimit: 256 * 1024});
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: 256 * 1024 }, (_request, body, done) => {
    try { done(null, parseStrictJson(body as Buffer)); }
    catch { done(new ApiError(400,"invalid_request")); }
  });
  const sessions = new WeakMap<FastifyRequest, Session>();
  app.addHook("onRequest",async(_req,reply)=>{reply.header("Cache-Control","no-store");});
  app.addHook("preHandler",async(req,reply)=>{
    // Only the OIDC login/callback routes are reachable without a session.
    if ((req.routeOptions.config as {public?:boolean}|undefined)?.public===true) return;
    const session = await config.authenticate(req);
    if (!session) return reply.code(401).send(error("authentication_required"));
    sessions.set(req,session);
    if (req.method !== "GET") {
      if (req.headers.origin !== config.origin || req.headers["x-csrf-token"] !== session.csrfToken)
        return reply.code(403).send(error("csrf_failed"));
      if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json")
        return reply.code(415).send(error("unsupported_media_type"));
    }
  });
  app.setErrorHandler((cause, _request, reply) => {
    if (cause instanceof DraftValidationError) return reply.code(422).send({error:{
      ...error("validation_failed").error,field:cause.field,
      ...(cause.rowNumbers.length ? {rowNumbers:cause.rowNumbers} : {}),
    }});
    let status=500, code="internal_error";
    if (cause instanceof ApiError) ({status,code}=cause);
    else if (cause instanceof ClaimError) {
      ({code}=cause);status=CLAIM_STATUS[cause.code];
    } else if (cause instanceof PollError) {
      code=cause.code;status=code==="not_found"?404:code==="validation_failed"?422:409;
    } else if (cause && typeof cause === "object" && "statusCode" in cause) {
      if (cause.statusCode === 413) {status=413;code="payload_too_large";}
      else if (cause.statusCode === 415) {status=415;code="unsupported_media_type";}
      else if (cause.statusCode === 400) {status=400;code="invalid_request";}
    }
    // No exception details, input, session, eligibility or key material in errors/logs.
    return reply.code(status).send(error(code));
  });
  const withClient = async <T>(action: (client: Client) => Promise<T>): Promise<T> => {
    const {client,release}=await config.acquireClient();
    try{return await action(client);}finally{await release();}
  };
  const ownerPoll = async (client: Client, owner: string, id: string) => {
    if (!isCanonicalUuidV4(id)) throw new PollError("not_found");
    const {rows}=await client.query(
      `WITH deadline_clock AS MATERIALIZED (SELECT clock_timestamp() AS instant)
       SELECT p.id,p.title,p.description,p.invalidated,p.created_at,p.opened_at,p.closes_at,
              p.revision,p.questions,p.eligible_count,
              CASE WHEN p.state='open' AND deadline_clock.instant >= p.closes_at THEN 'closed' ELSE p.state END AS effective_state,
              CASE WHEN p.state='open' AND deadline_clock.instant >= p.closes_at THEN p.closes_at ELSE p.closed_at END AS effective_closed_at
         FROM polls p CROSS JOIN deadline_clock WHERE p.id=$1 AND p.organiser_id=$2`,[id,owner],
    );
    if (!rows[0]) throw new PollError("not_found");
    const p=rows[0];
    const emails=(await client.query<{email:string}>(
      "SELECT email FROM identity.eligibility WHERE poll_id=$1 ORDER BY email",[id],
    )).rows.map((entry)=>entry.email);
    return {
      id:p.id,title:p.title,description:p.description,
      status:p.effective_state,invalidated:p.invalidated,
      createdAt:p.created_at.toISOString(),openedAt:p.opened_at?.toISOString()??null,
      closedAt:p.effective_closed_at?.toISOString()??null,
      closesAt:p.closes_at.toISOString(),revision:p.revision,questions:p.questions,
      eligibleCount:p.eligible_count,eligibilityEmails:emails,eligibilityRetention:"retained",
      policy:{version:1,minEligible:10,minResponses:5,minAnswersPerQuestion:5},
    };
  };
  if (config.auth) {
    const auth=config.auth;
    if (auth.oidc) registerOidcRoutes(app,{oidc:auth.oidc,acquireClient:auth.acquireClient,store:auth.store});
    // Session + exact Origin + CSRF + JSON already enforced by the preHandler.
    app.post("/api/v1/auth/logout",async(req,reply)=>{
      fields(req.body,[]);
      const token=readTokenCookie(req.headers.cookie,SESSION_COOKIE);
      if (token) await auth.store.revoke(token);
      return reply.code(204).header("Set-Cookie",clearedCookie(SESSION_COOKIE)).send();
    });
  }
  app.get("/api/v1/session",async(req)=>{
    const session=sessions.get(req)!;
    if (typeof session.email!=="string") throw new ApiError(500,"internal_error");
    return {user:{id:session.id,email:session.email,isOrganiser:session.isOrganiser},csrfToken:session.csrfToken};
  });
  app.post("/api/v1/polls",async(req,reply)=>{
    const user=sessions.get(req)!;
    if (!user.isOrganiser) throw new ApiError(403,"forbidden");
    return withClient(async(client)=>{
      const {id}=await createDraft(client,user.id,req.body,config.keyDirectory,config.encryptionKey);
      return reply.code(201).send(await ownerPoll(client,user.id,id));
    });
  });
  app.get("/api/v1/polls",async(req)=>{
    const owner=sessions.get(req)!.id;
    const query=new URL(req.url,config.origin).searchParams;
    if ([...query.keys()].some((key)=>key!=="limit" && key!=="cursor") ||
        query.getAll("limit").length>1 || query.getAll("cursor").length>1) throw new ApiError(400,"invalid_request");
    const limitText=query.get("limit")??"20";
    if (!/^[1-9][0-9]?$/.test(limitText) || Number(limitText)>50) throw new ApiError(400,"invalid_request");
    const limit=Number(limitText);
    let after:{createdAt:string;id:string}|null=null;
    const token=query.get("cursor");
    if (token!==null) {
      try {after=readCursor(token,owner,config.cursorKey);}
      catch {throw new ApiError(400,"invalid_request");}
    }
    return withClient(async(client)=>{
      const {rows}=await client.query(
        `WITH deadline_clock AS MATERIALIZED (SELECT clock_timestamp() AS instant)
         SELECT p.id,p.title,p.description,p.state,p.invalidated,p.created_at,p.opened_at,p.closed_at,p.closes_at,
                p.revision,p.eligible_count,
                to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_cursor,
                CASE WHEN p.state='open' AND deadline_clock.instant >= p.closes_at THEN 'closed' ELSE p.state END AS effective_state,
                CASE WHEN p.state='open' AND deadline_clock.instant >= p.closes_at THEN p.closes_at ELSE p.closed_at END AS effective_closed_at
           FROM polls p CROSS JOIN deadline_clock WHERE p.organiser_id=$1
             AND ($2::timestamptz IS NULL OR (p.created_at,p.id)<($2::timestamptz,$3::uuid))
           ORDER BY p.created_at DESC,p.id DESC LIMIT $4`,
        [owner,after?.createdAt??null,after?.id??null,limit+1],
      );
      const page=rows.slice(0,limit);
      return {items:page.map((p)=>({
        id:p.id,title:p.title,description:p.description,status:p.effective_state,invalidated:p.invalidated,
        createdAt:p.created_at.toISOString(),openedAt:p.opened_at?.toISOString()??null,
        closedAt:p.effective_closed_at?.toISOString()??null,closesAt:p.closes_at.toISOString(),
        revision:p.revision,eligibleCount:p.eligible_count,eligibilityRetention:"retained",
        policy:{version:1,minEligible:10,minResponses:5,minAnswersPerQuestion:5},
      })),nextCursor:rows.length>limit?
        makeCursor(owner,page.at(-1).created_cursor,page.at(-1).id,config.cursorKey):null};
    });
  });
  app.get<{Params:{id:string}}>("/api/v1/polls/:id",async(req)=>
    withClient((client)=>ownerPoll(client,sessions.get(req)!.id,req.params.id)));
  // Owner only; the database function checks ownership before any threshold (SPEC.md §11).
  app.get<{Params:{id:string}}>("/api/v1/polls/:id/results",async(req,reply)=>{
    if (req.url.includes("?")) throw new ApiError(400,"invalid_request"); // no filters, subgroups or exports
    const outcome=await withClient((client)=>readResults(client,sessions.get(req)!.id,req.params.id));
    if (outcome.outcome==="ready") return outcome.result;
    const status=outcome.outcome==="not_found"?404:outcome.outcome==="results_not_closed"?409:410;
    return reply.code(status).send(error(outcome.outcome));
  });
  app.get<{Params:{id:string}}>("/api/v1/polls/:id/claim-context",async(req)=>withClient(async(client)=>{
    if (!isCanonicalUuidV4(req.params.id)) throw new PollError("not_found");
    const {rows}=await client.query(
      `SELECT id,title,description,state,invalidated,opened_at,closed_at,closes_at,questions,
              policy_version,key_id,key_version,suite,public_jwk
         FROM public_polls WHERE id=$1`,[req.params.id],
    );
    if (!rows[0]) throw new PollError("not_found");
    const p=rows[0];
    return {
      id:p.id,title:p.title,description:p.description,status:p.state,invalidated:p.invalidated,
      openedAt:p.opened_at.toISOString(),closedAt:p.closed_at?.toISOString()??null,
      closesAt:p.closes_at.toISOString(),questions:p.questions,
      policy:{version:p.policy_version,minEligible:10,minResponses:5,minAnswersPerQuestion:5},
      key:{keyId:p.key_id,keyVersion:p.key_version,suite:p.suite,modulusBits:3072,publicJwk:p.public_jwk},
    };
  }));
  app.put<{Params:{id:string}}>("/api/v1/polls/:id",async(req)=>{
    const user=sessions.get(req)!;
    if (!user.isOrganiser) throw new ApiError(403,"forbidden");
    const body=fields(req.body,["revision","draft"]);
    if (typeof body.revision!=="number" || !Number.isSafeInteger(body.revision)) throw new ApiError(400,"invalid_request");
    return withClient(async(client)=>{
      await updateDraft(client,user.id,req.params.id,body.revision as number,body.draft);
      return ownerPoll(client,user.id,req.params.id);
    });
  });
  app.delete<{Params:{id:string}}>("/api/v1/polls/:id",async(req,reply)=>{
    const user=sessions.get(req)!;
    if (!user.isOrganiser) throw new ApiError(403,"forbidden");
    fields(req.body,[]);
    await withClient((client)=>deleteDraft(client,user.id,req.params.id,config.keyDirectory));
    return reply.code(204).send();
  });
  app.post<{Params:{id:string}}>("/api/v1/polls/:id/open",async(req)=>{
    const user=sessions.get(req)!;
    if (!user.isOrganiser) throw new ApiError(403,"forbidden");
    const rev=revision(req.body);
    return withClient(async(client)=>{
      await openPoll(client,user.id,req.params.id,rev);
      return ownerPoll(client,user.id,req.params.id);
    });
  });
  app.post<{Params:{id:string}}>("/api/v1/polls/:id/close",async(req)=>{
    const user=sessions.get(req)!;
    if (!user.isOrganiser) throw new ApiError(403,"forbidden");
    fields(req.body,[]);
    return withClient(async(client)=>{
      await closePoll(client,user.id,req.params.id);
      return ownerPoll(client,user.id,req.params.id);
    });
  });
  if (config.issuer) {
    const issuer=config.issuer;
    // SPEC.md §14 claim limits: two concurrent signs, ten waiting up to 2 s; five attempts/min/account.
    const capacity=createSigningCapacity({concurrent:2,queue:10,waitMs:2000,healthy:()=>issuer.signer.healthy()});
    const limiter=createAccountLimiter({limit:5,windowMs:60_000});
    app.post<{Params:{id:string}}>("/api/v1/polls/:id/claim",{bodyLimit:2048},async(req,reply)=>{
      const user=sessions.get(req)!;
      if (typeof user.email!=="string") throw new ApiError(403,"forbidden");
      const decision=limiter.attempt(user.id);
      if (!decision.allowed) {
        return reply.code(429).header("Retry-After",String(decision.retryAfterSeconds)).send(error("rate_limited"));
      }
      let lease: {client: Client; release: () => Promise<void>};
      try {lease=await issuer.acquireClient();}
      catch {throw new ClaimError("capacity_unavailable");}
      try {
        // Exactly one attempt: no automatic retry at any layer (SPEC.md §9).
        const result=await issueClaim(lease.client,{id:user.id,email:user.email},req.params.id,req.body,{
          reserve:capacity.reserve,
          loadKey:(ref)=>loadPrivateKey(config.keyDirectory,config.encryptionKey,ref),
          sign:(key,blinded)=>issuer.signer.sign(key,blinded),
        });
        return reply.code(201).send(result);
      } finally {
        await lease.release().catch(()=>{});
      }
    });
  }
  return app;
}
