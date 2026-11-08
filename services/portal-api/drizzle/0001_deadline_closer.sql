-- Forward-only addition for databases already migrated before the closer existed.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'feedback_closer') THEN
    CREATE ROLE feedback_closer NOLOGIN;
  END IF;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO feedback_closer;
--> statement-breakpoint
GRANT SELECT (id, state, closes_at) ON polls TO feedback_closer;
--> statement-breakpoint
GRANT UPDATE (state, closed_at, updated_at) ON polls TO feedback_closer;
