import { Client } from "pg";
import { afterAll, beforeAll, expect, inject, test } from "vitest";

const client = new Client({ connectionString: inject("testDatabaseUrl") });
beforeAll(() => client.connect());
afterAll(() => client.end());

test("runs against a fresh disposable PostgreSQL 17 database with durable commits", async () => {
  const { rows } = await client.query<{ db: string; version: string; fsync: string; synchronous_commit: string; tables: string }>(
    `SELECT current_database() AS db,
            current_setting('server_version_num') AS version,
            current_setting('fsync') AS fsync,
            current_setting('synchronous_commit') AS synchronous_commit,
            (SELECT count(*) FROM information_schema.tables
              WHERE table_schema NOT IN ('pg_catalog', 'information_schema'))::text AS tables`,
  );
  expect(rows[0].db).toMatch(/^feedback_test_\d+_[0-9a-f]{8}$/);
  expect(Number(rows[0].version)).toBeGreaterThanOrEqual(170000);
  expect(Number(rows[0].version)).toBeLessThan(180000);
  expect(rows[0]).toMatchObject({ fsync: "on", synchronous_commit: "on", tables: "0" });
});
