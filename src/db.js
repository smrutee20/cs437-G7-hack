// One SQL dialect everywhere. With DATABASE_URL we use real Postgres. Without it we use PGlite,
// Postgres compiled to WebAssembly, so `npm start` works on a fresh laptop with nothing else.
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS forms (
  id text PRIMARY KEY,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  questions jsonb NOT NULL,
  key_n text NOT NULL,
  key_e text NOT NULL,
  private_key text NOT NULL,
  admin_hash text NOT NULL,
  status text NOT NULL DEFAULT 'open'
);
CREATE TABLE IF NOT EXISTS invites (
  id bigserial PRIMARY KEY,
  form_id text NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  label text NOT NULL,
  code text NOT NULL UNIQUE,
  collected boolean NOT NULL DEFAULT false,
  blinded_hash text
);
CREATE UNIQUE INDEX IF NOT EXISTS invites_one_per_person ON invites (form_id, lower(label));
-- Spent ballots and responses are kept apart on purpose, and neither has a timestamp.
CREATE TABLE IF NOT EXISTS spent_ballots (
  form_id text NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  token text NOT NULL,
  signature text NOT NULL,
  PRIMARY KEY (form_id, token)
);
CREATE TABLE IF NOT EXISTS responses (
  id text PRIMARY KEY,
  form_id text NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  answers jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS responses_by_form ON responses (form_id);
`;

async function openPostgres(url) {
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  await pool.query(SCHEMA);
  return {
    query: (sql, params) => pool.query(sql, params),
    async tx(work) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work({ query: (sql, params) => client.query(sql, params) });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

async function openPglite(dataDir) {
  const db = new PGlite(dataDir);
  await db.waitReady;
  await db.exec(SCHEMA);
  return {
    query: (sql, params) => db.query(sql, params),
    tx: (work) => db.transaction((tx) => work({ query: (sql, params) => tx.query(sql, params) })),
    close: () => db.close(),
  };
}

export const openDb = ({ url, dataDir } = {}) => (url ? openPostgres(url) : openPglite(dataDir));
