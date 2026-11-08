// Creates one disposable database per `npm run test:db` run and drops it afterwards.
// Uses the local Compose admin role only to create/drop that database; application
// runtime roles are created by migrations once they exist (PLAN.md Milestone 2).
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  interface ProvidedContext {
    testDatabaseUrl: string;
  }
}

const DEFAULT_ADMIN_URL =
  "postgres://feedback_local_admin:feedback_local_only_not_for_production@127.0.0.1:55432/feedback_local";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export default async function setup(project: TestProject) {
  const adminUrl = new URL(process.env.FEEDBACK_TEST_DB_ADMIN_URL ?? DEFAULT_ADMIN_URL);
  if (!LOOPBACK.has(adminUrl.hostname)) {
    throw new Error("SETUP ERROR: DB tests only run against a loopback disposable PostgreSQL service.");
  }
  const admin = new Client({ connectionString: adminUrl.href, connectionTimeoutMillis: 3_000 });
  try {
    await admin.connect();
  } catch (error) {
    throw new Error(
      `SETUP ERROR: disposable PostgreSQL is unreachable at ${adminUrl.host} (${(error as Error).message}). ` +
        "Start it with `docker compose up -d --wait postgres`. This is an environment failure, not a test result.",
    );
  }
  // Backup copies made by the recovery test are dropped in its finally block; remove any
  // left behind by an interrupted run so they never accumulate.
  for (const { datname } of (await admin.query("SELECT datname FROM pg_database WHERE datname LIKE 'feedback_test_%_backup'")).rows) {
    await admin.query(`DROP DATABASE IF EXISTS ${datname} WITH (FORCE)`);
  }
  const name = `feedback_test_${Date.now()}_${randomBytes(4).toString("hex")}`;
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const testUrl = new URL(adminUrl.href);
  testUrl.pathname = `/${name}`;
  project.provide("testDatabaseUrl", testUrl.href);

  return async () => {
    const cleanup = new Client({ connectionString: adminUrl.href, connectionTimeoutMillis: 3_000 });
    await cleanup.connect();
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } finally {
      await cleanup.end();
    }
  };
}
