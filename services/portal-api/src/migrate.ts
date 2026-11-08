// Deployment-only migration entry point. Never give this credential to an API.
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

export async function migrateFoundation(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await migrate(drizzle(pool), {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
  } finally {
    await pool.end();
  }
}

// Destructive local-test rollback only. Not an API or production recovery operation.
export async function rollbackFoundation(databaseUrl: string): Promise<void> {
  const target = new URL(databaseUrl);
  if (!new Set(["127.0.0.1", "localhost", "[::1]"]).has(target.hostname) ||
      !/^\/feedback_test_\d+_[0-9a-f]{8}$/.test(target.pathname)) {
    throw new Error("rollback requires a loopback disposable test database");
  }
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query(`DROP VIEW IF EXISTS public_polls;
      DROP TABLE IF EXISTS anonymous.result_snapshots, anonymous.responses, identity.claims, identity.eligibility, signing_keys, polls, identity.users;
      DROP FUNCTION IF EXISTS create_draft_poll(uuid,uuid,text,text,timestamptz,jsonb,uuid,jsonb,bytea,text,text[]),
        delete_draft_poll(uuid,uuid), freeze_open_poll(), freeze_open_eligibility(), freeze_open_key();
      DROP SCHEMA IF EXISTS anonymous, identity, operations, drizzle CASCADE;
      GRANT CREATE ON SCHEMA public TO PUBLIC;`);
  } finally {
    await pool.end();
  }
}
