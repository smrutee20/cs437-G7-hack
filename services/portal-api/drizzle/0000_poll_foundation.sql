-- Deployment-only migration owner runs this; never run with an API credential.
CREATE SCHEMA identity;
--> statement-breakpoint
CREATE SCHEMA anonymous;
--> statement-breakpoint
CREATE SCHEMA operations;
--> statement-breakpoint
REVOKE ALL ON SCHEMA operations FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON SCHEMA identity FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON SCHEMA anonymous FROM PUBLIC;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'feedback_response_public') THEN
    CREATE ROLE feedback_response_public NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'feedback_portal_admin') THEN
    CREATE ROLE feedback_portal_admin NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'feedback_issuer') THEN
    CREATE ROLE feedback_issuer NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'feedback_key_janitor') THEN
    CREATE ROLE feedback_key_janitor NOLOGIN;
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE identity.users (
  id uuid PRIMARY KEY,
  issuer text NOT NULL,
  subject text NOT NULL,
  email text NOT NULL,
  is_organiser boolean NOT NULL DEFAULT false,
  UNIQUE (issuer, subject)
);
--> statement-breakpoint
CREATE TABLE polls (
  id uuid PRIMARY KEY,
  organiser_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  title text NOT NULL,
  description text NOT NULL,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','open','closed')),
  invalidated boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  opened_at timestamptz,
  closed_at timestamptz,
  closes_at timestamptz NOT NULL,
  questions jsonb NOT NULL,
  eligible_count integer NOT NULL DEFAULT 0,
  policy_version integer NOT NULL DEFAULT 1 CHECK (policy_version = 1),
  min_responses integer NOT NULL DEFAULT 5 CHECK (min_responses = 5),
  min_answers_per_question integer NOT NULL DEFAULT 5 CHECK (min_answers_per_question = 5),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  CONSTRAINT opened_time CHECK (state = 'draft' OR opened_at IS NOT NULL),
  CONSTRAINT closed_time CHECK (state <> 'closed' OR closed_at IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE signing_keys (
  key_id uuid PRIMARY KEY,
  poll_id uuid NOT NULL UNIQUE REFERENCES polls(id) ON DELETE RESTRICT,
  key_version integer NOT NULL DEFAULT 1 CHECK (key_version = 1),
  suite text NOT NULL CHECK (suite = 'RSABSSA-SHA384-PSS-Randomized'),
  public_jwk jsonb NOT NULL,
  fingerprint bytea NOT NULL UNIQUE CHECK (octet_length(fingerprint) = 32),
  private_secret_ref text NOT NULL UNIQUE
);
--> statement-breakpoint
CREATE TABLE identity.eligibility (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  poll_id uuid NOT NULL REFERENCES polls(id) ON DELETE RESTRICT,
  email text NOT NULL,
  UNIQUE (poll_id, email),
  UNIQUE (poll_id, id)
);
--> statement-breakpoint
CREATE TABLE identity.claims (
  poll_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  eligibility_id uuid NOT NULL,
  PRIMARY KEY (poll_id, user_id),
  UNIQUE (poll_id, eligibility_id),
  FOREIGN KEY (poll_id, eligibility_id) REFERENCES identity.eligibility(poll_id, id) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE operations.purge_tombstones (
  poll_id uuid PRIMARY KEY,
  purged_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
--> statement-breakpoint
CREATE FUNCTION freeze_open_poll() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.state <> 'draft' THEN
    IF (NEW.title,NEW.description,NEW.questions,NEW.closes_at,NEW.eligible_count,
        NEW.policy_version,NEW.min_responses,NEW.min_answers_per_question,NEW.organiser_id,NEW.revision)
       IS DISTINCT FROM
       (OLD.title,OLD.description,OLD.questions,OLD.closes_at,OLD.eligible_count,
        OLD.policy_version,OLD.min_responses,OLD.min_answers_per_question,OLD.organiser_id,OLD.revision)
       OR NEW.id IS DISTINCT FROM OLD.id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.opened_at IS DISTINCT FROM OLD.opened_at
       OR (NEW.state = OLD.state AND NEW.closed_at IS DISTINCT FROM OLD.closed_at)
       OR NEW.state NOT IN (OLD.state, 'closed') OR OLD.state = 'closed' AND NEW.state <> 'closed' THEN
      RAISE EXCEPTION 'frozen poll' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER polls_freeze BEFORE UPDATE ON polls FOR EACH ROW EXECUTE FUNCTION freeze_open_poll();
--> statement-breakpoint
CREATE FUNCTION freeze_open_eligibility() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.polls
    WHERE id = ANY (ARRAY[OLD.poll_id,NEW.poll_id]) AND state <> 'draft') THEN
    RAISE EXCEPTION 'frozen eligibility' USING ERRCODE = '23514';
  END IF;
  RETURN COALESCE(NEW,OLD);
END $$;
--> statement-breakpoint
CREATE TRIGGER eligibility_freeze BEFORE INSERT OR UPDATE OR DELETE ON identity.eligibility
  FOR EACH ROW EXECUTE FUNCTION freeze_open_eligibility();
--> statement-breakpoint
-- An unkeyed or draft poll cannot be published even if accidentally marked open.
CREATE FUNCTION freeze_open_key() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.polls
    WHERE id = ANY (ARRAY[OLD.poll_id,NEW.poll_id]) AND state <> 'draft') THEN
    RAISE EXCEPTION 'frozen signing key' USING ERRCODE = '23514';
  END IF;
  RETURN COALESCE(NEW,OLD);
END $$;
--> statement-breakpoint
CREATE TRIGGER signing_key_freeze BEFORE INSERT OR UPDATE OR DELETE ON signing_keys
  FOR EACH ROW EXECUTE FUNCTION freeze_open_key();
--> statement-breakpoint
CREATE VIEW public_polls WITH (security_barrier = true) AS
  WITH deadline_clock AS MATERIALIZED (SELECT clock_timestamp() AS instant)
  SELECT p.id,p.title,p.description,
         CASE WHEN p.state = 'open' AND deadline_clock.instant >= p.closes_at THEN 'closed' ELSE p.state END AS state,
         p.invalidated,p.opened_at,
         CASE WHEN p.state = 'open' AND deadline_clock.instant >= p.closes_at THEN p.closes_at ELSE p.closed_at END AS closed_at,
         p.closes_at,p.questions,p.policy_version,k.key_id,k.key_version,k.suite,k.public_jwk
  FROM polls p JOIN signing_keys k ON k.poll_id = p.id CROSS JOIN deadline_clock WHERE p.state <> 'draft';
--> statement-breakpoint
-- This single-statement call commits poll/key/eligibility atomically. Only the
-- portal's authenticated organiser route may supply p_owner; this function also
-- checks organiser provisioning but does not substitute for a session check.
CREATE FUNCTION create_draft_poll(
  p_id uuid, p_owner uuid, p_title text, p_description text, p_closes_at timestamptz,
  p_questions jsonb, p_key_id uuid, p_public_jwk jsonb, p_fingerprint bytea,
  p_private_ref text, p_emails text[]
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM identity.users WHERE id = p_owner AND is_organiser) THEN
    RAISE EXCEPTION 'not an organiser' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM operations.purge_tombstones WHERE poll_id=p_id) THEN
    RAISE EXCEPTION 'purged poll id' USING ERRCODE = '23505';
  END IF;
  INSERT INTO public.polls(id,organiser_id,title,description,closes_at,questions,eligible_count)
    VALUES(p_id,p_owner,p_title,p_description,p_closes_at,p_questions,array_length(p_emails,1));
  INSERT INTO public.signing_keys(key_id,poll_id,suite,public_jwk,fingerprint,private_secret_ref)
    VALUES(p_key_id,p_id,'RSABSSA-SHA384-PSS-Randomized',p_public_jwk,p_fingerprint,p_private_ref);
  INSERT INTO identity.eligibility(poll_id,email)
    SELECT p_id, email FROM unnest(p_emails) AS email;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION create_draft_poll(uuid,uuid,text,text,timestamptz,jsonb,uuid,jsonb,bytea,text,text[]) FROM PUBLIC;
--> statement-breakpoint
-- Only draft data can be removed; a tombstone survives to protect restoration.
CREATE FUNCTION delete_draft_poll(p_id uuid, p_owner uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_state text;
BEGIN
  SELECT state INTO v_state FROM public.polls
    WHERE id=p_id AND organiser_id=p_owner FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_state <> 'draft' THEN
    RAISE EXCEPTION 'invalid state' USING ERRCODE = '23514';
  END IF;
  DELETE FROM identity.eligibility WHERE poll_id=p_id;
  DELETE FROM public.signing_keys WHERE poll_id=p_id;
  DELETE FROM public.polls WHERE id=p_id;
  INSERT INTO operations.purge_tombstones(poll_id) VALUES(p_id);
  RETURN true;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION delete_draft_poll(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA public, identity, anonymous, operations FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO feedback_response_public;
--> statement-breakpoint
GRANT SELECT ON public_polls TO feedback_response_public;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public, identity TO feedback_portal_admin;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION create_draft_poll(uuid,uuid,text,text,timestamptz,jsonb,uuid,jsonb,bytea,text,text[]) TO feedback_portal_admin;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION delete_draft_poll(uuid,uuid) TO feedback_portal_admin;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON polls TO feedback_portal_admin;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON identity.eligibility TO feedback_portal_admin;
--> statement-breakpoint
GRANT SELECT (key_id, poll_id, key_version, suite, public_jwk) ON signing_keys TO feedback_portal_admin;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public, identity TO feedback_issuer;
--> statement-breakpoint
GRANT SELECT (id, state, invalidated, closes_at) ON polls TO feedback_issuer;
--> statement-breakpoint
GRANT SELECT (id, issuer, subject, email) ON identity.users TO feedback_issuer;
--> statement-breakpoint
GRANT SELECT (id, poll_id, email) ON identity.eligibility TO feedback_issuer;
--> statement-breakpoint
GRANT SELECT (key_id, poll_id, key_version, public_jwk, private_secret_ref) ON signing_keys TO feedback_issuer;
--> statement-breakpoint
GRANT INSERT ON identity.claims TO feedback_issuer;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO feedback_key_janitor;
--> statement-breakpoint
GRANT SELECT (key_id) ON signing_keys TO feedback_key_janitor;
--> statement-breakpoint
