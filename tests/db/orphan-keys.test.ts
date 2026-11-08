import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll,beforeAll,expect,inject,test } from "vitest";
import { provisionPollKey } from "../../services/portal-api/src/keys";
import { migrateFoundation,rollbackFoundation } from "../../services/portal-api/src/migrate";
import { sweepOrphanedKeys } from "../../services/portal-api/src/orphan-keys";

const url=inject("testDatabaseUrl"), client=new Client({connectionString:url});
let directory:string;
beforeAll(async()=>{await migrateFoundation(url);directory=await mkdtemp(join(tmpdir(),"feedback-orphans-"));await client.connect();});
afterAll(async()=>{await client.end();await rollbackFoundation(url);if(directory)await rm(directory,{recursive:true,force:true});});

test("background key janitor removes only old unreferenced encrypted keys with restricted DB rights",async()=>{
  const master=randomBytes(32), owner=randomUUID(), poll=randomUUID();
  const linked=await provisionPollKey(directory,master);
  const stale=await provisionPollKey(directory,master);
  const young=await provisionPollKey(directory,master);
  await client.query(`INSERT INTO identity.users(id,issuer,subject,email,is_organiser)
    VALUES($1,'https://accounts.google.com','janitor-owner','janitor@iitgn.ac.in',true)`,[owner]);
  await client.query(`INSERT INTO polls(id,organiser_id,title,description,closes_at,questions)
    VALUES($1,$2,'Key owner','',now()+interval '1 day','[]')`,[poll,owner]);
  await client.query(`INSERT INTO signing_keys(key_id,poll_id,suite,public_jwk,fingerprint,private_secret_ref)
    VALUES($1,$2,'RSABSSA-SHA384-PSS-Randomized',$3,$4,$5)`,
    [linked.keyId,poll,JSON.stringify(linked.publicJwk),linked.fingerprint,linked.privateSecretRef]);
  const now=new Date();
  const old=new Date(now.getTime()-48*3600*1000);
  await utimes(join(directory,linked.keyId),old,old);
  await utimes(join(directory,stale.keyId),old,old);
  await client.query("SET ROLE feedback_key_janitor");
  await expect(client.query("SELECT private_secret_ref FROM signing_keys")).rejects.toMatchObject({code:"42501"});
  await expect(client.query("SELECT * FROM identity.eligibility")).rejects.toMatchObject({code:"42501"});
  expect(await sweepOrphanedKeys(client,directory,now)).toBe(1);
  expect(new Set(await readdir(directory))).toEqual(new Set([linked.keyId,young.keyId]));
});
