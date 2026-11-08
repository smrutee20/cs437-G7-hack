// SPEC.md §12 / §17 scenario 20: every runtime role holds exactly the privileges its
// job needs, and nothing that would let it read forbidden tables or bypass ownership
// or publication through functions, views, search-path tricks or direct SQL.
// The expected sets below are written from each role's purpose, not read back.
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import { migrateFoundation, rollbackFoundation } from "../../services/portal-api/src/migrate";

const url = inject("testDatabaseUrl");
const admin = new Client({ connectionString: url });
const HELPERS = ["effective_closed_at(text,timestamp with time zone,timestamp with time zone)",
  "poll_access_expired(text,timestamp with time zone,timestamp with time zone)"];
const PREDICATES = ["is_table_owner(oid)", "poll_is_open(uuid)"];
const EXPECTED: Record<string, { tables: string[]; functions: string[]; schemas: string[] }> = {
  feedback_response_public: { schemas: ["anonymous", "public"],
    tables: ["public.public_polls:SELECT"],
    functions: ["anonymous.redeem(uuid,bytea,jsonb)", ...HELPERS, ...PREDICATES] },
  feedback_portal_admin: { schemas: ["anonymous", "identity", "operations", "public"],
    tables: ["identity.eligibility:DELETE", "identity.eligibility:INSERT", "identity.eligibility:SELECT",
      "public.polls:SELECT", "public.public_polls:SELECT",
      ...["closed_at", "closes_at", "description", "eligible_count", "opened_at", "questions", "revision", "state", "title", "updated_at"]
        .map((column) => `public.polls(${column}):UPDATE`),
      ...["key_id", "key_version", "poll_id", "public_jwk", "suite"].map((column) => `public.signing_keys(${column}):SELECT`)],
    functions: ["anonymous.publish_results(uuid,uuid)", "create_draft_poll(uuid,uuid,text,text,timestamp with time zone,jsonb,uuid,jsonb,bytea,text,text[])",
      "delete_draft_poll(uuid,uuid,bigint)", "operations.journal_seq()", ...HELPERS,
      "eligibility_expired(text,timestamp with time zone,timestamp with time zone)", ...PREDICATES] },
  feedback_issuer: { schemas: ["identity", "public"],
    tables: [...["closes_at", "id", "invalidated", "state"].map((column) => `public.polls(${column}):SELECT`),
      ...["key_id", "key_version", "poll_id", "private_secret_ref", "public_jwk"].map((column) => `public.signing_keys(${column}):SELECT`)],
    functions: ["identity.claim_entitlement(uuid,uuid,text,uuid)", ...PREDICATES] },
  feedback_auth: { schemas: ["identity", "operations"],
    tables: ["identity.oauth_transactions:DELETE", "identity.oauth_transactions:INSERT", "identity.oauth_transactions:SELECT",
      "identity.sessions:DELETE", "identity.sessions:INSERT", "identity.sessions:SELECT",
      "identity.users(id):SELECT", "identity.users(is_organiser):SELECT"],
    functions: ["identity.upsert_verified_user(text,text,text)", "operations.expire_auth_state()", ...PREDICATES] },
  feedback_closer: { schemas: ["public"],
    tables: [...["closes_at", "id", "state"].map((column) => `public.polls(${column}):SELECT`),
      ...["closed_at", "state", "updated_at"].map((column) => `public.polls(${column}):UPDATE`)],
    functions: [...PREDICATES] },
  feedback_retention: { schemas: ["operations", "public"],
    tables: ["public.signing_keys(key_id):SELECT"],
    functions: ["operations.expire_auth_state()", "operations.keys_pending_destruction()", "operations.lock_purge_candidate(uuid,text)",
      "operations.mark_key_destroyed(uuid)", "operations.purge_candidates()", "operations.purge_poll(uuid,text,bigint)",
      "operations.retention_sweep()", "operations.journal_seq()", ...PREDICATES] },
  feedback_operator: { schemas: ["operations"], tables: [],
    functions: ["operations.journal_seq()", "operations.keys_pending_destruction()", "operations.live_key_refs()", "operations.lock_poll(uuid)",
      "operations.mark_key_destroyed(uuid)", "operations.set_organiser(text,text,boolean)", "operations.withdraw_poll(uuid,text,bigint)", ...PREDICATES] },
  feedback_key_janitor: { schemas: ["public"], tables: ["public.signing_keys(key_id):SELECT"], functions: [...PREDICATES] },
};
const SCHEMAS = ["public", "identity", "anonymous", "operations", "drizzle"];

async function actual(role: string) {
  const tables = (await admin.query<{ grant: string }>(
    `WITH rels AS (SELECT c.oid, n.nspname || '.' || c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = ANY($2) AND c.relkind IN ('r','v','m','p','S'))
     SELECT name || ':' || priv AS grant FROM rels CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) priv
      WHERE has_table_privilege($1, oid, priv)
     UNION
     SELECT name || '(' || a.attname || '):' || priv FROM rels JOIN pg_attribute a ON a.attrelid = rels.oid AND a.attnum > 0 AND NOT a.attisdropped
       CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) priv
      WHERE has_column_privilege($1, rels.oid, a.attnum, priv) AND NOT has_table_privilege($1, rels.oid, priv)`, [role, SCHEMAS])).rows.map((r) => r.grant);
  const functions = (await admin.query<{ fn: string }>(
    `SELECT regexp_replace(p.oid::regprocedure::text, '^public\\.', '') AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = ANY($2) AND p.prorettype <> 'trigger'::regtype AND has_function_privilege($1, p.oid, 'EXECUTE')`, [role, SCHEMAS])).rows.map((r) => r.fn);
  const schemas = (await admin.query<{ nspname: string }>(
    "SELECT nspname FROM pg_namespace WHERE nspname = ANY($2) AND has_schema_privilege($1, oid, 'USAGE')", [role, SCHEMAS])).rows.map((r) => r.nspname);
  return { tables: tables.sort(), functions: functions.sort(), schemas: schemas.sort() };
}

beforeAll(async () => { await migrateFoundation(url); await admin.connect(); });
afterAll(async () => { await admin.end(); await rollbackFoundation(url); });

test.skipIf(!process.env.DUMP_PRIVILEGES)("dump", async () => {
  for (const role of Object.keys(EXPECTED)) {
    const got = await actual(role), want = EXPECTED[role];
    const diff = (a: string[], b: string[]) => a.filter((x) => !b.includes(x));
    console.log(role, JSON.stringify({ extraTables: diff(got.tables, want.tables), missingTables: diff(want.tables, got.tables),
      extraFns: diff(got.functions, want.functions), missingFns: diff(want.functions, got.functions),
      extraSchemas: diff(got.schemas, want.schemas), missingSchemas: diff(want.schemas, got.schemas) }));
  }
});

describe("runtime role privileges", () => {
  for (const [role, expected] of Object.entries(EXPECTED)) {
    test(`${role} holds exactly its least-privilege set`, async () => {
      expect(await actual(role)).toEqual({ tables: [...expected.tables].sort(), functions: [...expected.functions].sort(), schemas: [...expected.schemas].sort() });
    });
  }

  test("no runtime role can create objects, use temporary tables, or own anything", async () => {
    for (const role of Object.keys(EXPECTED)) {
      const row = (await admin.query(`SELECT has_database_privilege($1, current_database(), 'CREATE') AS db_create,
          has_database_privilege($1, current_database(), 'TEMPORARY') AS temp,
          (SELECT bool_or(has_schema_privilege($1, oid, 'CREATE')) FROM pg_namespace WHERE nspname = ANY($2)) AS schema_create,
          (SELECT count(*) FROM pg_class WHERE relowner = (SELECT oid FROM pg_roles WHERE rolname = $1))::int AS owned,
          (SELECT rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolcanlogin FROM pg_roles WHERE rolname = $1) AS elevated`,
        [role, SCHEMAS])).rows[0];
      expect(row, role).toEqual({ db_create: false, temp: false, schema_create: false, owned: 0, elevated: false });
    }
  });

  test("every SECURITY DEFINER function pins a safe search_path and none is executable by PUBLIC", async () => {
    const { rows } = await admin.query(
      `SELECT p.oid::regprocedure::text AS fn, p.proconfig, has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = ANY($1) AND p.prosecdef`, [SCHEMAS]);
    expect(rows.length).toBeGreaterThan(15);
    for (const row of rows) {
      expect(row.proconfig, row.fn).toContain("search_path=pg_catalog");
      expect(row.public_exec, row.fn).toBe(false);
    }
  });

  test("search-path and temporary-object tricks fail for request roles; forbidden reads are refused", async () => {
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      for (const role of ["feedback_response_public", "feedback_portal_admin", "feedback_issuer", "feedback_auth"]) {
        await client.query(`SET ROLE ${role}`);
        await expect(client.query("CREATE TEMP TABLE polls (id uuid)"), role).rejects.toMatchObject({ code: "42501" });
        await expect(client.query("CREATE SCHEMA attacker"), role).rejects.toMatchObject({ code: "42501" });
        await expect(client.query("CREATE FUNCTION public.clock_timestamp() RETURNS timestamptz LANGUAGE sql AS 'SELECT now()'"), role)
          .rejects.toMatchObject({ code: "42501" });
        await client.query("RESET ROLE");
      }
      await client.query("SET ROLE feedback_response_public");
      for (const sql of ["SELECT * FROM polls", "SELECT * FROM identity.users", "SELECT * FROM identity.claims", "SELECT * FROM anonymous.responses",
        "SELECT * FROM anonymous.result_snapshots", "SELECT private_secret_ref FROM signing_keys", "SELECT * FROM operations.purge_tombstones",
        "SELECT * FROM drizzle.__drizzle_migrations", "SELECT operations.purge_poll_now(gen_random_uuid())",
        "SELECT * FROM anonymous.publish_results(gen_random_uuid(), gen_random_uuid())"]) {
        await expect(client.query(sql), sql).rejects.toMatchObject({ code: "42501" });
      }
      await client.query("RESET ROLE");
      await client.query("SET ROLE feedback_portal_admin");
      for (const sql of ["SELECT * FROM identity.claims", "SELECT * FROM anonymous.responses", "SELECT * FROM identity.users",
        "SELECT * FROM identity.sessions", "SELECT private_secret_ref FROM signing_keys", "UPDATE polls SET organiser_id = gen_random_uuid()",
        "UPDATE polls SET invalidated = false", "INSERT INTO polls(id, organiser_id, title, description, closes_at, questions) VALUES (gen_random_uuid(), gen_random_uuid(), 't', '', now(), '[]')",
        "DELETE FROM polls", "SELECT identity.claim_entitlement(gen_random_uuid(), gen_random_uuid(), 'a@iitgn.ac.in', gen_random_uuid())"]) {
        await expect(client.query(sql), sql).rejects.toMatchObject({ code: "42501" });
      }
    } finally { await client.end(); }
  });
});
