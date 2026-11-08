import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, expect, inject, test } from "vitest";
import { createDraft } from "../../services/portal-api/src/create-draft";
import { migrateFoundation, rollbackFoundation } from "../../services/portal-api/src/migrate";
import { closePoll, openPoll, updateDraft } from "../../services/portal-api/src/poll-lifecycle";

const url = inject("testDatabaseUrl"), client = new Client({connectionString:url});
const owner = randomUUID(), other = randomUUID(), master = randomBytes(32);
let directory: string;
const draft = () => ({title:"Starting title",description:"",
  closesAt:new Date(Date.now()+86400000).toISOString(),
  questions:[{id:randomUUID(),type:"rating",prompt:"Score?",required:true}],
  eligibilityEmails:Array.from({length:10},(_,i)=>`student${i}@iitgn.ac.in`),
});
beforeAll(async () => {
  await migrateFoundation(url);
  directory=await mkdtemp(join(tmpdir(),"feedback-lifecycle-"));
  await client.connect();
  await client.query(`INSERT INTO identity.users(id,issuer,subject,email,is_organiser) VALUES
    ($1,'https://accounts.google.com','owner-1','owner1@iitgn.ac.in',true),
    ($2,'https://accounts.google.com','owner-2','owner2@iitgn.ac.in',true)`, [owner,other]);
  await client.query("SET ROLE feedback_portal_admin");
});
afterAll(async () => {await client.end(); await rollbackFoundation(url); if (directory) await rm(directory,{recursive:true,force:true});});

test("non-owner sees not-found; stale revisions and frozen content cannot mutate an open poll", async () => {
  const {id} = await createDraft(client, owner, draft(), directory, master);
  await expect(updateDraft(client,other,id,1,{...draft(),title:"Forged"})).rejects.toMatchObject({code:"not_found"});
  await expect(openPoll(client,other,id,1)).rejects.toMatchObject({code:"not_found"});
  await expect(closePoll(client,other,id)).rejects.toMatchObject({code:"not_found"});
  const modified = {...draft(),title:"New title"};
  expect(await updateDraft(client,owner,id,1,modified)).toMatchObject({revision:2,status:"draft"});
  await expect(updateDraft(client,owner,id,1,modified)).rejects.toMatchObject({code:"draft_conflict"});
  expect(await openPoll(client,owner,id,2)).toMatchObject({revision:2,status:"open"});
  expect(await openPoll(client,owner,id,2)).toMatchObject({revision:2,status:"open"});
  await expect(updateDraft(client,owner,id,2,modified)).rejects.toMatchObject({code:"invalid_state"});
  await expect(client.query("UPDATE polls SET title='bypassed' WHERE id=$1",[id])).rejects.toMatchObject({code:"23514"});
  expect((await client.query("SELECT title,revision FROM polls WHERE id=$1",[id])).rows[0]).toEqual({title:"New title",revision:2});
  expect(await closePoll(client,owner,id)).toMatchObject({revision:2,status:"closed"});
  expect(await closePoll(client,owner,id)).toMatchObject({revision:2,status:"closed"});
  await expect(openPoll(client,owner,id,2)).rejects.toMatchObject({code:"invalid_state"});
});

test("two owners of the same draft cannot both win a stale-revision update", async () => {
  const {id}=await createDraft(client,owner,draft(),directory,master);
  const rival=new Client({connectionString:url});
  await rival.connect();
  try {
    await rival.query("SET ROLE feedback_portal_admin");
    const attempts=await Promise.allSettled([
      updateDraft(client,owner,id,1,{...draft(),title:"First"}),
      updateDraft(rival,owner,id,1,{...draft(),title:"Second"}),
    ]);
    expect(attempts.filter((attempt)=>attempt.status==="fulfilled")).toHaveLength(1);
    const failure=attempts.find((attempt)=>attempt.status==="rejected");
    expect(failure).toMatchObject({status:"rejected",reason:{code:"draft_conflict"}});
    expect((await client.query("SELECT revision FROM polls WHERE id=$1",[id])).rows[0].revision).toBe(2);
  } finally {await rival.end();}
});

test("open versus draft edit serializes: no open poll contains post-opening edits", async () => {
  const initial=draft(), {id}=await createDraft(client,owner,initial,directory,master);
  const rival=new Client({connectionString:url});await rival.connect();
  try {
    await rival.query("SET ROLE feedback_portal_admin");
    const outcomes=await Promise.allSettled([
      openPoll(client,owner,id,1),
      updateDraft(rival,owner,id,1,{...draft(),title:"Racing edit"}),
    ]);
    expect(outcomes.filter((result)=>result.status==="fulfilled")).toHaveLength(1);
    const result=(await client.query("SELECT state,title,revision FROM polls WHERE id=$1",[id])).rows[0];
    if(result.state==="open") {
      expect(result).toMatchObject({title:initial.title,revision:1});
      expect(outcomes[1]).toMatchObject({status:"rejected",reason:{code:"invalid_state"}});
    } else {
      expect(result).toMatchObject({state:"draft",title:"Racing edit",revision:2});
      expect(outcomes[0]).toMatchObject({status:"rejected",reason:{code:"draft_conflict"}});
    }
  } finally {await rival.end();}
});

test("open versus close serializes; a draft close never closes a future poll", async () => {
  const {id}=await createDraft(client,owner,draft(),directory,master);
  const rival=new Client({connectionString:url});await rival.connect();
  try {
    await rival.query("SET ROLE feedback_portal_admin");
    const outcomes=await Promise.allSettled([
      closePoll(rival,owner,id),
      openPoll(client,owner,id,1),
    ]);
    expect(outcomes[1]).toMatchObject({status:"fulfilled"});
    const row=(await client.query("SELECT state,opened_at,closed_at FROM polls WHERE id=$1",[id])).rows[0];
    expect(row.opened_at).not.toBeNull();
    if(outcomes[0].status==="fulfilled") {
      expect(row).toMatchObject({state:"closed"});
      expect(row.closed_at).not.toBeNull();
    } else {
      expect(outcomes[0]).toMatchObject({status:"rejected",reason:{code:"invalid_state"}});
      expect(row).toMatchObject({state:"open",closed_at:null});
    }
  } finally {await rival.end();}
});

test("an expired stored-open poll cannot be reported as open on a retry", async () => {
  const expired=draft(); expired.closesAt="2020-01-01T00:00:00Z";
  const {id}=await createDraft(client,owner,expired,directory,master);
  // Simulates an overdue scheduler/old database row; the API must use effective status.
  await client.query("UPDATE polls SET state='open',opened_at=clock_timestamp() WHERE id=$1",[id]);
  expect(await openPoll(client,owner,id,1)).toMatchObject({status:"closed"});
  expect((await client.query("SELECT state,closed_at,closes_at FROM polls WHERE id=$1",[id])).rows[0])
    .toMatchObject({state:"closed"});
});

test("opening enforces database-clock deadline bounds and leaves invalid drafts editable", async () => {
  const input=draft(); input.closesAt="2020-01-01T00:00:00Z";
  const {id}=await createDraft(client,owner,input,directory,master);
  await expect(openPoll(client,owner,id,1)).rejects.toMatchObject({code:"validation_failed"});
  expect((await client.query("SELECT state FROM polls WHERE id=$1",[id])).rows[0].state).toBe("draft");
  await expect(closePoll(client,owner,id)).rejects.toMatchObject({code:"invalid_state"});
  const fixed=draft();
  expect(await updateDraft(client,owner,id,1,fixed)).toMatchObject({revision:2});
  expect(await openPoll(client,owner,id,2)).toMatchObject({status:"open"});
});
