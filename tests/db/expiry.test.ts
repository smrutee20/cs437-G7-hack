import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll,beforeAll,expect,inject,test } from "vitest";
import { closeExpiredPolls } from "../../services/portal-api/src/expiry";
import { migrateFoundation,rollbackFoundation } from "../../services/portal-api/src/migrate";

const url=inject("testDatabaseUrl"),client=new Client({connectionString:url});
let expired:string,future:string;
beforeAll(async()=>{
  await migrateFoundation(url);await client.connect();
  const owner=randomUUID();expired=randomUUID();future=randomUUID();
  await client.query(`INSERT INTO identity.users(id,issuer,subject,email,is_organiser)
    VALUES($1,'https://accounts.google.com','closer-owner','closer@iitgn.ac.in',true)`,[owner]);
  await client.query(`INSERT INTO polls(id,organiser_id,title,description,closes_at,questions,state,opened_at)
    VALUES($1,$3,'Expired','',clock_timestamp()-interval '1 hour','[]','open',clock_timestamp()-interval '1 day'),
          ($2,$3,'Future','',clock_timestamp()+interval '1 day','[]','open',clock_timestamp())`,
    [expired,future,owner]);
  await client.query("SET ROLE feedback_closer");
});
afterAll(async()=>{await client.end();await rollbackFoundation(url);});

test("restricted closer materializes deadline closure exactly once without identity access",async()=>{
  await expect(client.query("SELECT * FROM identity.users")).rejects.toMatchObject({code:"42501"});
  await expect(client.query("SELECT * FROM signing_keys")).rejects.toMatchObject({code:"42501"});
  expect(await closeExpiredPolls(client)).toBe(1);
  expect(await closeExpiredPolls(client)).toBe(0);
  await client.query("RESET ROLE");
  const result=await client.query("SELECT id,state,closed_at,closes_at FROM polls WHERE id=ANY($1::uuid[])",[[expired,future]]);
  expect(result.rows.find((row)=>row.id===expired)).toMatchObject({state:"closed"});
  expect(result.rows.find((row)=>row.id===expired).closed_at).toEqual(result.rows.find((row)=>row.id===expired).closes_at);
  expect(result.rows.find((row)=>row.id===future)).toMatchObject({state:"open",closed_at:null});
});
