import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll,beforeAll,expect,inject,test } from "vitest";
import { createApp } from "../../services/portal-api/src/index";
import { migrateFoundation,rollbackFoundation } from "../../services/portal-api/src/migrate";

const url=inject("testDatabaseUrl"), owner=randomUUID(), other=randomUUID();
const origin="https://portal.feedback.test:4173";
let dir:string,app:ReturnType<typeof createApp>;
const input=()=>({title:"Temporary draft",description:"",closesAt:new Date(Date.now()+86400000).toISOString(),
  questions:[{id:randomUUID(),type:"rating",prompt:"Score?",required:true}],
  eligibilityEmails:Array.from({length:10},(_,i)=>`guest${i}@iitgn.ac.in`)});
beforeAll(async()=>{
  await migrateFoundation(url);dir=await mkdtemp(join(tmpdir(),"feedback-delete-"));
  const admin=new Client({connectionString:url});await admin.connect();
  try{await admin.query(`INSERT INTO identity.users(id,issuer,subject,email,is_organiser) VALUES
    ($1,'https://accounts.google.com','delete-owner','owner@iitgn.ac.in',true),
    ($2,'https://accounts.google.com','delete-other','other@iitgn.ac.in',true)`, [owner,other]);}
  finally{await admin.end();}
  app=createApp({origin,keyDirectory:dir,encryptionKey:randomBytes(32),cursorKey:randomBytes(32),
    authenticate:async(req)=>({id:req.headers.cookie?.includes("__Host-session=other")?other:owner,
      isOrganiser:true,csrfToken:"csrf"}),
    acquireClient:async()=>{const client=new Client({connectionString:url});await client.connect();
      await client.query("SET ROLE feedback_portal_admin");return {client,release:()=>client.end()};},
  });
});
afterAll(async()=>{await app?.close();await rollbackFoundation(url);if(dir)await rm(dir,{recursive:true,force:true});});
const request=(method:"POST"|"DELETE"|"GET",path:string,token="owner",payload?:unknown)=>app.inject({
  method,url:`/api/v1${path}`,payload:method==="DELETE"?"{}":payload===undefined?undefined:JSON.stringify(payload),
  headers:{cookie:`__Host-session=${token}`,origin,"x-csrf-token":"csrf","content-type":"application/json"},
});

test("only owner can delete a draft, destroying its key and writing a non-identifying tombstone",async()=>{
  const created=await request("POST","/polls","owner",input());expect(created.statusCode).toBe(201);
  const id=created.json().id;
  const files=await readdir(dir);expect(files).toHaveLength(1);
  expect((await request("DELETE",`/polls/${id}`,"other")).statusCode).toBe(404);
  expect(await readdir(dir)).toEqual(files);
  const deleted=await request("DELETE",`/polls/${id}`);expect(deleted.statusCode).toBe(204);
  expect(await readdir(dir)).toEqual([]);
  expect((await request("GET",`/polls/${id}`)).statusCode).toBe(404);
  const check=new Client({connectionString:url});await check.connect();
  try {
    expect((await check.query("SELECT poll_id FROM operations.purge_tombstones WHERE poll_id=$1",[id])).rows)
      .toEqual([{poll_id:id}]);
    expect((await check.query("SELECT id FROM polls WHERE id=$1",[id])).rows).toEqual([]);
    expect((await check.query("SELECT poll_id FROM identity.eligibility WHERE poll_id=$1",[id])).rows).toEqual([]);
    expect((await check.query("SELECT poll_id FROM signing_keys WHERE poll_id=$1",[id])).rows).toEqual([]);
    await check.query("SET ROLE feedback_portal_admin");
    await expect(check.query(
      `SELECT create_draft_poll($1,$2,'restored','',now() + interval '1 day','[]'::jsonb,
        $3,'{}'::jsonb,$4,$5,ARRAY['guest@iitgn.ac.in'])`,
      [id,owner,randomUUID(),Buffer.alloc(32,7),randomUUID()],
    )).rejects.toMatchObject({code:"23505"});
    await check.query("SET ROLE feedback_response_public");
    await expect(check.query("SELECT * FROM operations.purge_tombstones")).rejects.toMatchObject({code:"42501"});
  } finally {await check.end();}
  expect((await request("DELETE",`/polls/${id}`)).statusCode).toBe(404);
});

test("an opened poll cannot be deleted by an organiser",async()=>{
  const created=await request("POST","/polls","owner",input());expect(created.statusCode).toBe(201);
  const id=created.json().id;
  expect((await request("POST",`/polls/${id}/open`,"owner",{revision:1})).statusCode).toBe(200);
  expect((await request("DELETE",`/polls/${id}`)).statusCode).toBe(409);
});
