#!/usr/bin/env bash
# Direct disposable DDL/reset check until the first real Drizzle migration.
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U feedback_local_admin -d feedback_local <<'SQL'
CREATE SCHEMA foundation_check;
CREATE TABLE foundation_check.example (id integer PRIMARY KEY);
INSERT INTO foundation_check.example (id) VALUES (1);
DO $$ BEGIN IF (SELECT count(*) FROM foundation_check.example) <> 1 THEN RAISE EXCEPTION 'unexpected row count'; END IF; END $$;
DROP SCHEMA foundation_check CASCADE;
SQL
printf 'PASS: local DB DDL up/down and isolated reset.\n'
