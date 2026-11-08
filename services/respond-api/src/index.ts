import Fastify from "fastify";
import { isCanonicalUuidV4 } from "@iitgn-feedback/protocol";
import type { Client } from "pg";

// The response service receives a dedicated public DB role. No portal sessions,
// private-key store, identity connection, or cookies are configured here.
type Config = {acquireClient:()=>Promise<{client:Client;release:()=>Promise<void>}>};
const notFound = {error:{code:"not_found",message:"not found"}};
export function createApp(config: Config) {
  const app=Fastify({logger:false});
  app.addHook("onRequest",async(_req,reply)=>{reply.header("Cache-Control","no-store");});
  app.get<{Params:{id:string}}>("/api/v1/polls/:id/public",async(req,reply)=>{
    if (!isCanonicalUuidV4(req.params.id)) return reply.code(404).send(notFound);
    const {client,release}=await config.acquireClient();
    try {
      const {rows}=await client.query(
        `SELECT id,title,description,state,invalidated,opened_at,closed_at,closes_at,questions,
                policy_version,key_id,key_version,suite,public_jwk
           FROM public_polls WHERE id=$1`,[req.params.id],
      );
      if (!rows[0]) return reply.code(404).send(notFound);
      const p=rows[0];
      return {
        id:p.id,title:p.title,description:p.description,status:p.state,invalidated:p.invalidated,
        openedAt:p.opened_at.toISOString(),closedAt:p.closed_at?.toISOString()??null,
        closesAt:p.closes_at.toISOString(),questions:p.questions,
        policy:{version:p.policy_version,minEligible:10,minResponses:5,minAnswersPerQuestion:5},
        key:{keyId:p.key_id,keyVersion:p.key_version,suite:p.suite,modulusBits:3072,publicJwk:p.public_jwk},
      };
    } finally {await release();}
  });
  app.setErrorHandler((_cause,_req,reply)=>reply.code(500).send({error:{code:"internal_error",message:"internal error"}}));
  return app;
}
