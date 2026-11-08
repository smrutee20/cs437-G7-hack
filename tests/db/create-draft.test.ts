import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, expect, inject, test } from "vitest";
import { createDraft } from "../../services/portal-api/src/create-draft";
import { loadPrivateKey } from "../../services/portal-api/src/keys";
import { migrateFoundation, rollbackFoundation } from "../../services/portal-api/src/migrate";

const url = inject("testDatabaseUrl"), admin = new Client({ connectionString: url });
const owner = randomUUID(), unprovisioned = randomUUID(), master = randomBytes(32);
let directory: string;
const input = () => ({
  title: " My poll ", description: "", closesAt: "2026-11-14T12:00:00Z",
  questions: [{id: randomUUID(),type:"rating",prompt:"Rate this",required:true}],
  eligibilityEmails: Array.from({length: 10}, (_, i) => `student${i}@iitgn.ac.in`),
});
beforeAll(async () => {
  await migrateFoundation(url);
  directory = await mkdtemp(join(tmpdir(), "feedback-drafts-"));
  await admin.connect();
  await admin.query(`INSERT INTO identity.users(id,issuer,subject,email,is_organiser) VALUES
    ($1,'https://accounts.google.com','demo-owner','owner@iitgn.ac.in',true),
    ($2,'https://accounts.google.com','demo-other','other@iitgn.ac.in',false)`, [owner,unprovisioned]);
  await admin.query("SET ROLE feedback_portal_admin");
});
afterAll(async () => {
  await admin.end();
  await rollbackFoundation(url);
  if (directory) await rm(directory, {recursive:true,force:true});
});

test("validated draft persists key and eligibility atomically; invalid import creates nothing", async () => {
  const invalid = input(); invalid.eligibilityEmails[4] = "outside@example.org";
  await expect(createDraft(admin, owner, invalid, directory, master))
    .rejects.toMatchObject({ code: "validation_failed", rowNumbers: [5] });
  expect((await readdir(directory))).toEqual([]);
  expect((await admin.query("SELECT count(*)::int AS n FROM polls")).rows[0].n).toBe(0);

  const valid = input(); valid.eligibilityEmails.push(" STUDENT0@IITGN.AC.IN ");
  const { id } = await createDraft(admin, owner, valid, directory, master);
  const row = (await admin.query("SELECT title,state,eligible_count,revision FROM polls WHERE id=$1", [id])).rows[0];
  expect(row).toEqual({title:"My poll", state:"draft", eligible_count:10, revision:1});
  expect((await admin.query("SELECT count(*)::int AS n FROM identity.eligibility WHERE poll_id=$1", [id])).rows[0].n).toBe(10);
  await admin.query("SET ROLE feedback_response_public");
  expect((await admin.query("SELECT id FROM public_polls WHERE id=$1", [id])).rows).toEqual([]);
  await admin.query("SET ROLE feedback_portal_admin");
  const key = (await admin.query("SELECT key_id, public_jwk FROM signing_keys WHERE poll_id=$1", [id])).rows[0];
  expect((await readdir(directory))).toEqual([key.key_id]);
  const der = await loadPrivateKey(directory, master, key.key_id);
  expect(der.length).toBeGreaterThan(1000);
  expect(key.public_jwk.n).toHaveLength(512);
});

test("a non-organiser cannot create a draft and a definite DB rejection leaves no key file", async () => {
  const prior = await readdir(directory);
  await expect(createDraft(admin, unprovisioned, input(), directory, master))
    .rejects.toMatchObject({ code: "42501" });
  expect(await readdir(directory)).toEqual(prior);
});
