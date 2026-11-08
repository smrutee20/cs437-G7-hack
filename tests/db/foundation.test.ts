import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { expect, inject, test } from "vitest";
import { migrateFoundation, rollbackFoundation } from "../../services/portal-api/src/migrate";

const url = inject("testDatabaseUrl");

test("destructive rollback refuses a non-disposable database even when requested", async () => {
  await expect(rollbackFoundation("postgres://someone:secret@127.0.0.1:55432/feedback_local"))
    .rejects.toThrow(/disposable test database/);
});

// The migration runs with the disposable database owner, never with a runtime role.
test("migration up/down isolates private eligibility and exposes only non-draft public metadata", async () => {
  await migrateFoundation(url);
  await migrateFoundation(url); // safe on a restarted migration runner
  const admin = new Client({ connectionString: url });
  await admin.connect();
  try {
    const owner = randomUUID(), draft = randomUUID(), open = randomUUID(), expired = randomUUID();
    await admin.query(
      `INSERT INTO identity.users (id, issuer, subject, email, is_organiser)
       VALUES ($1,'https://accounts.google.com','synthetic-organiser','organiser@iitgn.ac.in',true)`, [owner],
    );
    await admin.query(
      `INSERT INTO polls (id, organiser_id, title, description, closes_at, questions, state, opened_at)
       VALUES ($1,$3,'Draft','',now() + interval '1 day','[]','draft',NULL),
              ($2,$3,'Open','',now() + interval '1 day','[]','draft',NULL),
              ($4,$3,'Expired','',now() - interval '1 second','[]','draft',NULL)`, 
      [draft, open, owner, expired],
    );
    await admin.query(`INSERT INTO identity.eligibility (poll_id,email) VALUES ($1,'eligible@iitgn.ac.in')`, [open]);
    await admin.query(
      `INSERT INTO signing_keys (key_id,poll_id,suite,public_jwk,fingerprint,private_secret_ref)
       VALUES ($1,$2,'RSABSSA-SHA384-PSS-Randomized',$3,$4,'synthetic-test-only')`,
      [randomUUID(), open, JSON.stringify({ kty: "RSA", e: "AQAB", n: "synthetic-test-only" }), Buffer.alloc(32, 1)],
    );
    await admin.query(
      `INSERT INTO signing_keys (key_id,poll_id,suite,public_jwk,fingerprint,private_secret_ref)
       VALUES ($1,$2,'RSABSSA-SHA384-PSS-Randomized',$3,$4,'synthetic-expired-only')`,
      [randomUUID(), expired, JSON.stringify({ kty: "RSA", e: "AQAB", n: "expired-test-only" }), Buffer.alloc(32, 2)],
    );
    await admin.query("UPDATE polls SET state='open',opened_at=clock_timestamp() WHERE id=$1", [open]);
    await admin.query("UPDATE polls SET state='open',opened_at=clock_timestamp() - interval '1 day' WHERE id=$1", [expired]);
    await admin.query("SET ROLE feedback_response_public");
    await expect(admin.query("SELECT * FROM identity.eligibility")).rejects.toMatchObject({ code: "42501" });
    await expect(admin.query("SELECT * FROM identity.users")).rejects.toMatchObject({ code: "42501" });
    await expect(admin.query("SELECT * FROM identity.claims")).rejects.toMatchObject({ code: "42501" });
    await expect(admin.query("SELECT * FROM signing_keys")).rejects.toMatchObject({ code: "42501" });
    await expect(admin.query("SELECT * FROM polls")).rejects.toMatchObject({ code: "42501" });
    const visible = await admin.query("SELECT id,title FROM public_polls ORDER BY title");
    expect(visible.rows).toEqual([{ id: expired, title: "Expired" }, { id: open, title: "Open" }]);
    // A deadline passing must be reflected without a scheduler updating stored state.
    const deadline = await admin.query("SELECT state, closed_at, closes_at FROM public_polls WHERE id=$1", [expired]);
    expect(deadline.rows[0].state).toBe("closed");
    expect(deadline.rows[0].closed_at).toEqual(deadline.rows[0].closes_at);
    await admin.query("RESET ROLE");
    await admin.query("SET ROLE feedback_portal_admin");
    expect((await admin.query("SELECT email FROM identity.eligibility WHERE poll_id=$1", [open])).rows)
      .toEqual([{ email: "eligible@iitgn.ac.in" }]);
    const newDraft = randomUUID(), badDraft = randomUUID();
    const emails = Array.from({ length: 10 }, (_, i) => `invite${i}@iitgn.ac.in`);
    const create = (pollId: string, entries: string[]) => admin.query(
      `SELECT create_draft_poll($1,$2,$3,$4,$5::timestamptz,$6::jsonb,$7,$8::jsonb,$9::bytea,$10,$11::text[])`,
      [pollId, owner, "Candidate", "", "2026-11-14T12:00:00Z", "[]", randomUUID(),
        JSON.stringify({kty:"RSA",e:"AQAB",n:"test-only"}), Buffer.alloc(32, 3), randomUUID(), entries],
    );
    await expect(create(badDraft, [...emails.slice(0, 9), emails[0]])).rejects.toMatchObject({ code: "23505" });
    expect((await admin.query("SELECT id FROM polls WHERE id=$1", [badDraft])).rows).toEqual([]);
    await create(newDraft, emails);
    expect((await admin.query("SELECT eligible_count FROM polls WHERE id=$1", [newDraft])).rows)
      .toEqual([{ eligible_count: 10 }]);
    expect((await admin.query("SELECT count(*)::int AS count FROM identity.eligibility WHERE poll_id=$1", [newDraft])).rows)
      .toEqual([{ count: 10 }]);
    await expect(admin.query("SELECT private_secret_ref FROM signing_keys"))
      .rejects.toMatchObject({ code: "42501" });
    await expect(admin.query("SELECT * FROM identity.claims"))
      .rejects.toMatchObject({ code: "42501" });
    await admin.query("RESET ROLE");
    await admin.query("SET ROLE feedback_issuer");
    expect((await admin.query("SELECT private_secret_ref FROM signing_keys WHERE poll_id=$1", [open])).rows)
      .toEqual([{ private_secret_ref: "synthetic-test-only" }]);
    await expect(admin.query("SELECT * FROM public_polls"))
      .rejects.toMatchObject({ code: "42501" });
    const permission = await admin.query(
      `SELECT has_function_privilege(current_user,
        'create_draft_poll(uuid,uuid,text,text,timestamptz,jsonb,uuid,jsonb,bytea,text,text[])', 'EXECUTE') AS allowed`,
    );
    expect(permission.rows[0].allowed).toBe(false);
    await admin.query("RESET ROLE");
    await expect(admin.query("UPDATE polls SET title='changed' WHERE id=$1", [open]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(admin.query("UPDATE polls SET opened_at=clock_timestamp() WHERE id=$1", [open]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(admin.query("UPDATE polls SET closed_at=clock_timestamp() WHERE id=$1", [open]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(admin.query("UPDATE signing_keys SET public_jwk='{}' WHERE poll_id=$1", [open]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(admin.query("DELETE FROM signing_keys WHERE poll_id=$1", [open]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(admin.query("UPDATE identity.eligibility SET poll_id=$1 WHERE poll_id=$2", [draft, open]))
      .rejects.toMatchObject({ code: "23514" });
  } finally {
    await admin.end();
  }
  await rollbackFoundation(url);
  const check = new Client({ connectionString: url });
  await check.connect();
  try {
    const result = await check.query("SELECT to_regclass('public.polls') AS polls, to_regclass('identity.users') AS users");
    expect(result.rows[0]).toEqual({ polls: null, users: null });
  } finally {
    await check.end();
  }
});
