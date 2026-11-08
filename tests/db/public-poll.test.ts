import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, expect, inject, test } from "vitest";
import { createDraft } from "../../services/portal-api/src/create-draft";
import { migrateFoundation, rollbackFoundation } from "../../services/portal-api/src/migrate";
import { closePoll, openPoll } from "../../services/portal-api/src/poll-lifecycle";
import { createApp } from "../../services/respond-api/src/index";

const url=inject("testDatabaseUrl"), admin=new Client({connectionString:url});
const owner=randomUUID(), master=randomBytes(32);
let directory:string, app:ReturnType<typeof createApp>;
beforeAll(async()=>{
  await migrateFoundation(url);
  directory=await mkdtemp(join(tmpdir(),"feedback-public-"));
  await admin.connect();
  await admin.query(`INSERT INTO identity.users(id,issuer,subject,email,is_organiser)
    VALUES($1,'https://accounts.google.com','synthetic-public-owner','owner@iitgn.ac.in',true)`,[owner]);
  await admin.query("SET ROLE feedback_portal_admin");
  app=createApp({acquireClient:async()=>{
    const client=new Client({connectionString:url});await client.connect();
    await client.query("SET ROLE feedback_response_public");
    return {client,release:()=>client.end()};
  }});
});
afterAll(async()=>{await app?.close();await admin.end();await rollbackFoundation(url);
  if (directory) await rm(directory,{recursive:true,force:true});});

test("anonymous public metadata hides drafts, eligibility and identity; closed metadata remains readable",async()=>{
  const input={title:"Public questions",description:"Description",
    closesAt:new Date(Date.now()+86400000).toISOString(),
    questions:[{id:randomUUID(),type:"rating",prompt:"Score?",required:true}],
    eligibilityEmails:Array.from({length:10},(_,i)=>`eligible${i}@iitgn.ac.in`)};
  const {id}=await createDraft(admin,owner,input,directory,master);
  const path=`/api/v1/polls/${id}/public`;
  expect((await app.inject({method:"GET",url:path})).statusCode).toBe(404);
  await openPoll(admin,owner,id,1);
  const reply=await app.inject({method:"GET",url:path});
  expect(reply.statusCode).toBe(200);
  expect(reply.headers["cache-control"]).toBe("no-store");
  const dto=reply.json();
  expect(Object.keys(dto).sort()).toEqual(["closedAt","closesAt","description","id","invalidated","key","openedAt","policy","questions","status","title"].sort());
  expect(dto).toMatchObject({id,status:"open",key:{keyVersion:1,modulusBits:3072,
    suite:"RSABSSA-SHA384-PSS-Randomized",publicJwk:{kty:"RSA",e:"AQAB"}}});
  expect(dto.key.publicJwk.n).toHaveLength(512);
  expect(Object.keys(dto.key).sort()).toEqual(["keyId","keyVersion","modulusBits","publicJwk","suite"].sort());
  expect(Object.keys(dto.key.publicJwk).sort()).toEqual(["e","kty","n"]);
  expect(JSON.stringify(dto)).not.toContain("eligible0@iitgn.ac.in");
  await closePoll(admin,owner,id);
  expect((await app.inject({method:"GET",url:path})).json()).toMatchObject({status:"closed"});
  expect((await app.inject({method:"GET",url:`/api/v1/polls/${randomUUID()}/public`})).statusCode).toBe(404);
});
