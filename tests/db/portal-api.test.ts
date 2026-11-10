import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, expect, inject, test, vi } from "vitest";
import { createApp } from "../../services/portal-api/src/index";
import { migrateFoundation, rollbackFoundation } from "../../services/portal-api/src/migrate";

const url=inject("testDatabaseUrl"), origin="https://portal.feedback.test:4173";
const owner=randomUUID(), other=randomUUID(), outsider=randomUUID(), master=randomBytes(32);
let directory:string;
const sessions=new Map([
  ["owner",{id:owner,email:"one@iitgn.ac.in",isOrganiser:true,csrfToken:"owner-csrf"}],
  ["other",{id:other,email:"two@iitgn.ac.in",isOrganiser:true,csrfToken:"other-csrf"}],
  ["outsider",{id:outsider,email:"three@iitgn.ac.in",isOrganiser:false,csrfToken:"outsider-csrf"}],
]);
const input=()=>({title:"Student feedback",description:"",closesAt:new Date(Date.now()+86400000).toISOString(),
  questions:[{id:randomUUID(),type:"rating",prompt:"How was it?",required:true}],
  eligibilityEmails:Array.from({length:10},(_,i)=>`student${i}@iitgn.ac.in`),
});
let app:ReturnType<typeof createApp>;
beforeAll(async()=>{
  await migrateFoundation(url);
  directory=await mkdtemp(join(tmpdir(),"feedback-api-"));
  const seed=new Client({connectionString:url});await seed.connect();
  try {await seed.query(`INSERT INTO identity.users(id,issuer,subject,email,is_organiser) VALUES
    ($1,'https://accounts.google.com','api-owner','one@iitgn.ac.in',true),
    ($2,'https://accounts.google.com','api-other','two@iitgn.ac.in',true),
    ($3,'https://accounts.google.com','api-outsider','three@iitgn.ac.in',false)`, [owner,other,outsider]);}
  finally {await seed.end();}
  app=createApp({origin,keyDirectory:directory,encryptionKey:master,cursorKey:randomBytes(32),
    authenticate:async(request)=>sessions.get(/(?:^|; )__Host-session=([^;]+)/.exec(request.headers.cookie??"")?.[1]??"")??null,
    acquireClient:async()=>{
      const client=new Client({connectionString:url});await client.connect();
      await client.query("SET ROLE feedback_portal_admin");
      return {client,release:()=>client.end()};
    },
  });
});
afterAll(async()=>{await app?.close();await rollbackFoundation(url);if (directory) await rm(directory,{recursive:true,force:true});});
const send=async(token:string, method:string, path:string, payload?:unknown, csrf?:string, requestOrigin=origin)=>
  await app.inject({
    method: method as "POST"|"GET"|"PUT", url:`/api/v1${path}`,
    payload:payload===undefined?undefined:JSON.stringify(payload),
    headers:{cookie:`__Host-session=${token}`,origin:requestOrigin,"x-csrf-token":csrf??"owner-csrf",
      "content-type":"application/json"},
  });

let firstPollId: string;
test("authenticated session exposes only own verified profile and synchronizer token",async()=>{
  const result=await send("owner","GET","/session");
  expect(result.statusCode).toBe(200);
  expect(result.json()).toEqual({user:{id:owner,email:"one@iitgn.ac.in",isOrganiser:true},csrfToken:"owner-csrf"});
  expect(result.headers["cache-control"]).toBe("no-store");
  expect((await send("nobody","GET","/session")).statusCode).toBe(401);
});

test("owner creates a draft via guarded API; other owners see 404 and no private/count fields",async()=>{
  expect((await send("owner","POST","/polls",input(),"bad")).statusCode).toBe(403);
  const wrongType=await app.inject({method:"POST",url:"/api/v1/polls",
    headers:{cookie:"__Host-session=owner",origin,"x-csrf-token":"owner-csrf","content-type":"text/plain"},
    payload:"{}"});
  expect(wrongType.statusCode).toBe(415);
  expect((await send("owner","POST","/polls",input(),"owner-csrf","https://respond.feedback.test:4174")).statusCode).toBe(403);
  expect((await send("outsider","POST","/polls",input(),"outsider-csrf")).statusCode).toBe(403);
  const invalid=input(); invalid.eligibilityEmails[1]="outsider@example.org";
  const rejected=await send("owner","POST","/polls",invalid);
  expect(rejected.statusCode).toBe(422);
  expect(rejected.json()).toMatchObject({error:{code:"validation_failed",field:"eligibilityEmails",rowNumbers:[2]}});
  expect(rejected.body).not.toContain("outsider@example.org");
  const rawHeaders={cookie:"__Host-session=owner",origin,"x-csrf-token":"owner-csrf","content-type":"application/json"};
  for (const firstKey of ["title","\\u0074itle"]) {
    const duplicate=JSON.stringify(input()).replace('{',`{"${firstKey}":"decoy",`);
    const response=await app.inject({method:"POST",url:"/api/v1/polls",headers:rawHeaders,payload:duplicate});
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({error:{code:"invalid_request"}});
  }
  const invalidUtf8=Buffer.from(JSON.stringify(input()).replace("Student feedback","Student ! feedback"));
  invalidUtf8[invalidUtf8.indexOf(33)]=0xff;
  expect((await app.inject({method:"POST",url:"/api/v1/polls",headers:rawHeaders,payload:invalidUtf8})).statusCode).toBe(400);
  const created=await send("owner","POST","/polls",input());
  expect(created.statusCode).toBe(201);
  expect(created.headers["cache-control"]).toBe("no-store");
  const dto=created.json();
  firstPollId=dto.id;
  expect((await send("outsider","GET",`/polls/${dto.id}/claim-context`,undefined,"outsider-csrf")).statusCode).toBe(404);
  expect(dto).toMatchObject({status:"draft",revision:1,eligibleCount:10,policy:{version:2,minEligible:1,minResponses:1,minAnswersPerQuestion:1}});
  expect(Object.keys(dto).sort()).toEqual(["closedAt","closesAt","createdAt","description","eligibleCount","eligibilityEmails","eligibilityRetention","id","invalidated","openedAt","policy","questions","revision","status","title"].sort());
  expect(JSON.stringify(dto)).not.toMatch(/privateSecretRef|claim|responseCount|fingerprint|subject/i);
  const wrongTypeOpen=await app.inject({method:"POST",url:`/api/v1/polls/${dto.id}/open`,
    headers:{cookie:"__Host-session=owner",origin,"x-csrf-token":"owner-csrf","content-type":"text/plain"},
    payload:"{}"});
  expect(wrongTypeOpen.statusCode).toBe(415);
  expect((await send("other","GET",`/polls/${dto.id}`,undefined,"other-csrf")).statusCode).toBe(404);
  expect((await send("owner","GET",`/polls/${dto.id}`)).json()).toEqual(dto);
  expect((await send("nobody","GET",`/polls/${dto.id}`)).statusCode).toBe(401);
  const updated=await send("owner","PUT",`/polls/${dto.id}`,{revision:1,draft:{...input(),title:"Updated"}});
  expect(updated.statusCode).toBe(200);
  expect(updated.json()).toMatchObject({title:"Updated",revision:2});
  expect((await send("owner","PUT",`/polls/${dto.id}`,{revision:1,draft:input()})).statusCode).toBe(409);
  const opened=await send("owner","POST",`/polls/${dto.id}/open`,{revision:2});
  expect(opened.statusCode).toBe(200);
  expect(opened.json()).toMatchObject({status:"open",revision:2});
  const context=await send("outsider","GET",`/polls/${dto.id}/claim-context`,undefined,"outsider-csrf");
  expect(context.statusCode).toBe(200);
  expect(Object.keys(context.json()).sort()).toEqual(["id","title","description","status","invalidated","openedAt","closedAt","closesAt","questions","policy","key"].sort());
  expect(context.json()).toMatchObject({id:dto.id,status:"open",key:{keyVersion:1,suite:"RSABSSA-SHA384-PSS-Randomized",modulusBits:3072}});
  expect(JSON.stringify(context.json())).not.toMatch(/student\d+@|owner|eligibleCount|claim|privateSecretRef/i);
  expect((await send("nobody","GET",`/polls/${dto.id}/claim-context`)).statusCode).toBe(401);
  // A browser/app clock cannot authorize early effective closure.
  const clock=vi.spyOn(Date,"now").mockReturnValue(Date.now()+40*86400000);
  try {expect((await send("owner","GET",`/polls/${dto.id}`)).json().status).toBe("open");}
  finally {clock.mockRestore();}
  expect((await send("owner","PUT",`/polls/${dto.id}`,{revision:2,draft:input()})).statusCode).toBe(409);
  const closed=await send("owner","POST",`/polls/${dto.id}/close`,{});
  expect(closed.json()).toMatchObject({status:"closed",revision:2});
});
