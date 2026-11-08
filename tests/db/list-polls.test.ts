import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll,beforeAll,expect,inject,test } from "vitest";
import { createApp } from "../../services/portal-api/src/index";
import { migrateFoundation,rollbackFoundation } from "../../services/portal-api/src/migrate";

const url=inject("testDatabaseUrl"), owner=randomUUID(), other=randomUUID();
const origin="https://portal.feedback.test:4173";
let dir:string,app:ReturnType<typeof createApp>;
const draft=()=>({title:"Listed poll",description:"",closesAt:new Date(Date.now()+86400000).toISOString(),
  questions:[{id:randomUUID(),type:"rating",prompt:"Score?",required:true}],
  eligibilityEmails:Array.from({length:10},(_,i)=>`member${i}@iitgn.ac.in`)});
beforeAll(async()=>{
  await migrateFoundation(url);dir=await mkdtemp(join(tmpdir(),"feedback-list-"));
  const admin=new Client({connectionString:url});await admin.connect();
  try{await admin.query(`INSERT INTO identity.users(id,issuer,subject,email,is_organiser) VALUES
    ($1,'https://accounts.google.com','list-owner','listowner@iitgn.ac.in',true),
    ($2,'https://accounts.google.com','list-other','listother@iitgn.ac.in',true)`, [owner,other]);}
  finally{await admin.end();}
  app=createApp({origin,keyDirectory:dir,encryptionKey:randomBytes(32),cursorKey:randomBytes(32),
    authenticate:async(req)=>req.headers.cookie?.includes("__Host-session=owner")?
      {id:owner,isOrganiser:true,csrfToken:"csrf"}:{id:other,isOrganiser:true,csrfToken:"csrf"},
    acquireClient:async()=>{const client=new Client({connectionString:url});await client.connect();
      await client.query("SET ROLE feedback_portal_admin");return {client,release:()=>client.end()};},
  });
});
afterAll(async()=>{await app?.close();await rollbackFoundation(url);if(dir)await rm(dir,{recursive:true,force:true});});
const request=(path:string,token="owner")=>app.inject({method:"GET",url:`/api/v1${path}`,headers:{cookie:`__Host-session=${token}`}});

test("owner-scoped opaque cursor paginates without leaking content or cross-owner data",async()=>{
  const empty=await request("/polls?limit=1");expect(empty.statusCode).toBe(200);
  expect(empty.json()).toEqual({items:[],nextCursor:null});
  const ids:string[]=[];
  for(let i=0;i<3;i++){
    const response=await app.inject({method:"POST",url:"/api/v1/polls",payload:JSON.stringify(draft()),
      headers:{cookie:"__Host-session=owner",origin,"x-csrf-token":"csrf","content-type":"application/json"}});
    expect(response.statusCode).toBe(201);ids.push(response.json().id);
  }
  // Fix identical database creation times to exercise the ID tie-breaker.
  const tie=new Client({connectionString:url});await tie.connect();
  // Fixture time travel runs as the owner: since 0009 the portal role cannot touch created_at.
  try {await tie.query("UPDATE polls SET created_at='2026-01-01T00:00:00.123456Z' WHERE id=ANY($1::uuid[])",[ids]);
  } finally {await tie.end();}
  const seen:string[]=[];let cursor:string|null=null;
  do {
    const result=await request(`/polls?limit=1${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`);
    expect(result.statusCode).toBe(200);
    const page=result.json();expect(page.items).toHaveLength(1);
    expect(Object.keys(page.items[0])).not.toContain("questions");
    expect(Object.keys(page.items[0])).not.toContain("eligibilityEmails");
    seen.push(page.items[0].id);cursor=page.nextCursor;
    if(cursor){
      const cross=await request(`/polls?limit=1&cursor=${encodeURIComponent(cursor)}`,"other");
      expect(cross.statusCode).toBe(400);
      const tampered=cursor.slice(0,-1)+(cursor.endsWith("x")?"y":"x");
      expect((await request(`/polls?limit=1&cursor=${encodeURIComponent(tampered)}`)).statusCode).toBe(400);
    }
  } while(cursor && seen.length<4);
  expect(seen).toEqual(ids.sort().reverse());
  expect((await request("/polls?limit=51")).statusCode).toBe(400);
  expect((await request("/polls?sort=createdAt")).statusCode).toBe(400);
  expect((await request("/polls?limit=1&limit=2")).statusCode).toBe(400);
});
