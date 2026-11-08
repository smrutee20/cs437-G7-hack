-- Forward-only. Retention, key destruction, operator withdrawal and the recovery
-- journal acknowledgement (SPEC.md §4, §6 key lifecycle, §15).
--
-- Protected rows (claims, responses, snapshots, frozen eligibility/keys, retained
-- polls) can be deleted only by code running as the table owner (reviewed
-- SECURITY DEFINER functions below, or the offline recovery procedure), and
-- never while their poll is open: live uniqueness state is immutable to every
-- role. Runtime request roles never can, and nobody can TRUNCATE them.
CREATE FUNCTION public.effective_closed_at(p_state text, p_closes_at timestamptz, p_closed_at timestamptz)
  RETURNS timestamptz LANGUAGE sql VOLATILE SET search_path = pg_catalog AS $$
  SELECT CASE WHEN p_state = 'open' AND clock_timestamp() >= p_closes_at THEN p_closes_at ELSE p_closed_at END
$$;
--> statement-breakpoint
-- Access expires 90 days after effective closure even if physical deletion is delayed.
CREATE FUNCTION public.poll_access_expired(p_state text, p_closes_at timestamptz, p_closed_at timestamptz)
  RETURNS boolean LANGUAGE sql VOLATILE SET search_path = pg_catalog AS $$
  SELECT p_state <> 'draft' AND COALESCE(
    public.effective_closed_at(p_state, p_closes_at, p_closed_at) + interval '90 days' <= clock_timestamp(), false)
$$;
--> statement-breakpoint
-- Eligibility becomes purged in owner DTOs seven days after effective closure.
CREATE FUNCTION public.eligibility_expired(p_state text, p_closes_at timestamptz, p_closed_at timestamptz)
  RETURNS boolean LANGUAGE sql VOLATILE SET search_path = pg_catalog AS $$
  SELECT p_state <> 'draft' AND COALESCE(
    public.effective_closed_at(p_state, p_closes_at, p_closed_at) + interval '7 days' <= clock_timestamp(), false)
$$;
--> statement-breakpoint
CREATE FUNCTION public.is_table_owner(p_table oid) RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT COALESCE((SELECT relowner FROM pg_class WHERE oid = p_table) =
                  (SELECT oid FROM pg_roles WHERE rolname = current_user), false)
$$;
--> statement-breakpoint
CREATE FUNCTION public.poll_is_open(p_poll uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM public.polls WHERE id = p_poll AND state = 'open')
$$;
--> statement-breakpoint
ALTER TABLE polls ADD COLUMN invalidation_reason text
  CHECK (invalidation_reason IN ('key_compromise','key_loss','restored_backup','integrity_failure','privacy_incident','operator'));
--> statement-breakpoint
ALTER TABLE polls ADD CONSTRAINT invalidation_reason_requires_flag CHECK (invalidation_reason IS NULL OR invalidated);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION freeze_open_poll() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  -- Withdrawal is permanent and its reason cannot be rewritten, in every state.
  IF (OLD.invalidated AND NOT NEW.invalidated) OR
     (OLD.invalidation_reason IS NOT NULL AND NEW.invalidation_reason IS DISTINCT FROM OLD.invalidation_reason) THEN
    RAISE EXCEPTION 'withdrawal is permanent' USING ERRCODE = '23514';
  END IF;
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
CREATE FUNCTION protect_poll_delete() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.state <> 'draft' AND (OLD.state = 'open' OR NOT public.is_table_owner(TG_RELID)) THEN
    RAISE EXCEPTION 'live or retained poll' USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER polls_protect_delete BEFORE DELETE ON polls FOR EACH ROW EXECUTE FUNCTION protect_poll_delete();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION freeze_open_eligibility() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.polls
    WHERE id = ANY (ARRAY[OLD.poll_id,NEW.poll_id]) AND state <> 'draft') THEN
    -- Only owner-context retention/purge may remove a frozen allowlist.
    IF TG_OP = 'DELETE' AND public.is_table_owner(TG_RELID) AND NOT public.poll_is_open(OLD.poll_id) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'frozen eligibility' USING ERRCODE = '23514';
  END IF;
  RETURN COALESCE(NEW,OLD);
END $$;
--> statement-breakpoint
ALTER TABLE signing_keys ADD COLUMN lifecycle text NOT NULL DEFAULT 'active'
  CHECK (lifecycle IN ('active','destroy_pending','destroyed'));
--> statement-breakpoint
ALTER TABLE signing_keys ALTER COLUMN private_secret_ref DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE signing_keys ADD CONSTRAINT destroyed_key_has_no_ref CHECK ((lifecycle = 'destroyed') = (private_secret_ref IS NULL));
--> statement-breakpoint
-- After opening, the only permitted key changes are the forward destruction
-- lifecycle; public material stays until the 90-day purge.
CREATE OR REPLACE FUNCTION freeze_open_key() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.polls
    WHERE id = ANY (ARRAY[OLD.poll_id,NEW.poll_id]) AND state <> 'draft') THEN
    RETURN COALESCE(NEW,OLD);
  END IF;
  IF TG_OP = 'UPDATE' AND
     (NEW.key_id, NEW.poll_id, NEW.key_version, NEW.suite, NEW.public_jwk, NEW.fingerprint)
       IS NOT DISTINCT FROM (OLD.key_id, OLD.poll_id, OLD.key_version, OLD.suite, OLD.public_jwk, OLD.fingerprint) AND
     ((OLD.lifecycle = 'active' AND NEW.lifecycle = 'destroy_pending' AND NEW.private_secret_ref = OLD.private_secret_ref) OR
      (OLD.lifecycle IN ('active','destroy_pending') AND NEW.lifecycle = 'destroyed' AND NEW.private_secret_ref IS NULL) OR
      (NEW.lifecycle = OLD.lifecycle AND NEW.private_secret_ref IS NOT DISTINCT FROM OLD.private_secret_ref)) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' AND public.is_table_owner(TG_RELID) AND NOT public.poll_is_open(OLD.poll_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'frozen signing key' USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
CREATE FUNCTION protect_retained_rows() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'retained uniqueness state cannot be truncated' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'immutable row' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_table_owner(TG_RELID) OR public.poll_is_open(OLD.poll_id) THEN
    RAISE EXCEPTION 'retained row' USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER claims_protect BEFORE UPDATE OR DELETE ON identity.claims FOR EACH ROW EXECUTE FUNCTION protect_retained_rows();
--> statement-breakpoint
CREATE TRIGGER claims_no_truncate BEFORE TRUNCATE ON identity.claims FOR EACH STATEMENT EXECUTE FUNCTION protect_retained_rows();
--> statement-breakpoint
CREATE TRIGGER responses_protect BEFORE UPDATE OR DELETE ON anonymous.responses FOR EACH ROW EXECUTE FUNCTION protect_retained_rows();
--> statement-breakpoint
CREATE TRIGGER responses_no_truncate BEFORE TRUNCATE ON anonymous.responses FOR EACH STATEMENT EXECUTE FUNCTION protect_retained_rows();
--> statement-breakpoint
CREATE TRIGGER snapshots_protect BEFORE UPDATE OR DELETE ON anonymous.result_snapshots FOR EACH ROW EXECUTE FUNCTION protect_retained_rows();
--> statement-breakpoint
CREATE TRIGGER snapshots_no_truncate BEFORE TRUNCATE ON anonymous.result_snapshots FOR EACH STATEMENT EXECUTE FUNCTION protect_retained_rows();
--> statement-breakpoint
CREATE OR REPLACE VIEW public_polls WITH (security_barrier = true) AS
  WITH deadline_clock AS MATERIALIZED (SELECT clock_timestamp() AS instant)
  SELECT p.id,p.title,p.description,
         CASE WHEN p.state = 'open' AND deadline_clock.instant >= p.closes_at THEN 'closed' ELSE p.state END AS state,
         p.invalidated,p.opened_at,
         CASE WHEN p.state = 'open' AND deadline_clock.instant >= p.closes_at THEN p.closes_at ELSE p.closed_at END AS closed_at,
         p.closes_at,p.questions,p.policy_version,k.key_id,k.key_version,k.suite,k.public_jwk
  FROM polls p JOIN signing_keys k ON k.poll_id = p.id CROSS JOIN deadline_clock
  WHERE p.state <> 'draft' AND NOT public.poll_access_expired(p.state, p.closes_at, p.closed_at);
--> statement-breakpoint
-- Same as 0004 plus the 90-day access boundary: an expired poll is not found.
CREATE OR REPLACE FUNCTION anonymous.redeem(p_poll uuid, p_nullifier bytea, p_answers jsonb)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog SET lock_timeout = '2s' AS $$
DECLARE
  v_state text;
  v_invalidated boolean;
  v_closes_at timestamptz;
  v_closed_at timestamptz;
  v_existing jsonb;
BEGIN
  IF p_nullifier IS NULL OR octet_length(p_nullifier) <> 32 OR p_answers IS NULL THEN
    RAISE EXCEPTION 'invalid redemption input' USING ERRCODE = '22023';
  END IF;
  SELECT state, invalidated, closes_at, closed_at INTO v_state, v_invalidated, v_closes_at, v_closed_at
    FROM public.polls WHERE id = p_poll FOR SHARE;
  IF NOT FOUND OR v_state = 'draft' OR public.poll_access_expired(v_state, v_closes_at, v_closed_at) THEN
    RETURN 'not_found';
  END IF;
  IF v_invalidated THEN RETURN 'poll_withdrawn'; END IF;
  PERFORM pg_advisory_xact_lock(('x' || encode(substring(sha256(
    convert_to('IITGN-FEEDBACK-REDEEM-LOCK', 'UTF8') || '\x00'::bytea || uuid_send(p_poll) || p_nullifier
  ) FROM 1 FOR 8), 'hex'))::bit(64)::bigint);
  SELECT answers INTO v_existing FROM anonymous.responses WHERE poll_id = p_poll AND nullifier = p_nullifier;
  IF FOUND THEN
    RETURN CASE WHEN v_existing = p_answers THEN 'replayed' ELSE 'credential_spent' END;
  END IF;
  IF v_state <> 'open' OR clock_timestamp() >= v_closes_at THEN RETURN 'poll_closed'; END IF;
  INSERT INTO anonymous.responses(poll_id, nullifier, answers) VALUES (p_poll, p_nullifier, p_answers)
    ON CONFLICT DO NOTHING;
  IF FOUND THEN RETURN 'inserted'; END IF;
  SELECT answers INTO v_existing FROM anonymous.responses WHERE poll_id = p_poll AND nullifier = p_nullifier;
  RETURN CASE WHEN v_existing = p_answers THEN 'replayed' ELSE 'credential_spent' END;
END $$;
--> statement-breakpoint
-- Same as 0005 plus the 90-day access boundary (not found) before anything else.
CREATE OR REPLACE FUNCTION anonymous.publish_results(p_poll uuid, p_owner uuid)
  RETURNS TABLE(outcome text, result jsonb) LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog SET lock_timeout = '2s' AS $$
DECLARE
  v_state text;
  v_invalidated boolean;
  v_closes_at timestamptz;
  v_closed_at timestamptz;
  v_questions jsonb;
  v_total integer;
  v_answered integer;
  v_items jsonb := '[]'::jsonb;
  v_question jsonb;
  v_snapshot jsonb;
BEGIN
  SELECT p.state, p.invalidated, p.closes_at, p.closed_at, p.questions
    INTO v_state, v_invalidated, v_closes_at, v_closed_at, v_questions
    FROM public.polls p WHERE p.id = p_poll AND p.organiser_id = p_owner FOR UPDATE;
  IF NOT FOUND OR public.poll_access_expired(v_state, v_closes_at, v_closed_at) THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::jsonb; RETURN;
  END IF;
  IF v_state = 'open' AND clock_timestamp() >= v_closes_at THEN
    UPDATE public.polls SET state = 'closed', closed_at = v_closes_at, updated_at = clock_timestamp() WHERE id = p_poll;
    v_state := 'closed';
  END IF;
  IF v_state <> 'closed' THEN RETURN QUERY SELECT 'results_not_closed'::text, NULL::jsonb; RETURN; END IF;
  IF v_invalidated THEN RETURN QUERY SELECT 'poll_withdrawn'::text, NULL::jsonb; RETURN; END IF;

  SELECT s.result INTO v_snapshot FROM anonymous.result_snapshots s WHERE s.poll_id = p_poll;
  IF FOUND THEN RETURN QUERY SELECT 'ready'::text, v_snapshot; RETURN; END IF;

  SELECT count(*) INTO v_total FROM anonymous.responses r WHERE r.poll_id = p_poll;
  IF v_total < 5 THEN
    RETURN QUERY SELECT 'ready'::text, '{"state":"withheld","reason":"insufficient_responses"}'::jsonb;
    RETURN;
  END IF;

  FOR v_question IN SELECT q FROM jsonb_array_elements(v_questions) WITH ORDINALITY AS t(q, n) ORDER BY n LOOP
    SELECT count(*) INTO v_answered
      FROM anonymous.responses r CROSS JOIN LATERAL jsonb_array_elements(r.answers) a
     WHERE r.poll_id = p_poll AND a->>'questionId' = v_question->>'id';
    IF v_answered < 5 THEN
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'questionId', v_question->>'id', 'state', 'withheld', 'reason', 'insufficient_answers'));
      CONTINUE;
    END IF;
    IF v_question->>'type' = 'single_choice' THEN
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'questionId', v_question->>'id', 'state', 'published', 'type', 'single_choice',
        'answeredCount', v_answered, 'skippedCount', v_total - v_answered,
        'options', (SELECT jsonb_agg(jsonb_build_object('optionId', o->>'id', 'count', c.n,
                       'percentage', round(c.n * 100.0 / v_answered, 1)) ORDER BY o_n)
                      FROM jsonb_array_elements(v_question->'options') WITH ORDINALITY AS opts(o, o_n)
                      CROSS JOIN LATERAL (SELECT count(*) AS n
                        FROM anonymous.responses r CROSS JOIN LATERAL jsonb_array_elements(r.answers) a
                       WHERE r.poll_id = p_poll AND a->>'questionId' = v_question->>'id' AND a->>'value' = o->>'id') c)));
    ELSIF v_question->>'type' = 'rating' THEN
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'questionId', v_question->>'id', 'state', 'published', 'type', 'rating',
        'answeredCount', v_answered, 'skippedCount', v_total - v_answered,
        'distribution', (SELECT jsonb_agg(jsonb_build_object('value', v.value, 'count', c.n,
                            'percentage', round(c.n * 100.0 / v_answered, 1)) ORDER BY v.value)
                           FROM generate_series(1, 5) AS v(value)
                           CROSS JOIN LATERAL (SELECT count(*) AS n
                             FROM anonymous.responses r CROSS JOIN LATERAL jsonb_array_elements(r.answers) a
                            WHERE r.poll_id = p_poll AND a->>'questionId' = v_question->>'id' AND (a->'value')::int = v.value) c),
        'mean', (SELECT round(avg((a->'value')::int), 2)
                   FROM anonymous.responses r CROSS JOIN LATERAL jsonb_array_elements(r.answers) a
                  WHERE r.poll_id = p_poll AND a->>'questionId' = v_question->>'id')));
    ELSE
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'questionId', v_question->>'id', 'state', 'published', 'type', 'free_text',
        'answeredCount', v_answered, 'skippedCount', v_total - v_answered,
        'texts', (SELECT jsonb_agg(a->'value' ORDER BY gen_random_uuid())
                    FROM anonymous.responses r CROSS JOIN LATERAL jsonb_array_elements(r.answers) a
                   WHERE r.poll_id = p_poll AND a->>'questionId' = v_question->>'id')));
    END IF;
  END LOOP;
  v_snapshot := jsonb_build_object('state', 'ready', 'totalResponses', v_total, 'questions', v_items);
  INSERT INTO anonymous.result_snapshots(poll_id, result) VALUES (p_poll, v_snapshot);
  RETURN QUERY SELECT 'ready'::text, v_snapshot;
END $$;
--> statement-breakpoint
-- Journal acknowledgement: every journaled purge/withdrawal advances this by
-- exactly one in the same transaction. Startup refuses to serve when it differs
-- from the journal head (an interrupted operation or a restored backup).
CREATE TABLE operations.journal_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_seq bigint NOT NULL DEFAULT 0 CHECK (last_seq >= 0)
);
--> statement-breakpoint
INSERT INTO operations.journal_state DEFAULT VALUES;
--> statement-breakpoint
CREATE FUNCTION operations.journal_seq() RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT last_seq FROM operations.journal_state
$$;
--> statement-breakpoint
CREATE FUNCTION operations.journal_ack(p_seq bigint) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  UPDATE operations.journal_state SET last_seq = p_seq WHERE last_seq = p_seq - 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'journal out of sequence' USING ERRCODE = '55000'; END IF;
END $$;
--> statement-breakpoint
-- Internal: physical purge of one poll and its tombstone. No grant; called only
-- by the checked wrappers below and by the offline recovery procedure.
CREATE FUNCTION operations.purge_poll_now(p_poll uuid) RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  DELETE FROM anonymous.result_snapshots WHERE poll_id = p_poll;
  DELETE FROM anonymous.responses WHERE poll_id = p_poll;
  DELETE FROM identity.claims WHERE poll_id = p_poll;
  DELETE FROM identity.eligibility WHERE poll_id = p_poll;
  DELETE FROM public.signing_keys WHERE poll_id = p_poll;
  DELETE FROM public.polls WHERE id = p_poll;
  INSERT INTO operations.purge_tombstones(poll_id) VALUES (p_poll) ON CONFLICT DO NOTHING;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION operations.purge_poll_now(uuid) FROM PUBLIC;
--> statement-breakpoint
-- Owner draft deletion, journaled (replaces the unjournaled 0000 function).
DROP FUNCTION delete_draft_poll(uuid, uuid);
--> statement-breakpoint
CREATE FUNCTION delete_draft_poll(p_id uuid, p_owner uuid, p_seq bigint) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_state text;
BEGIN
  SELECT state INTO v_state FROM public.polls WHERE id = p_id AND organiser_id = p_owner FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_state <> 'draft' THEN RAISE EXCEPTION 'invalid state' USING ERRCODE = '23514'; END IF;
  PERFORM operations.purge_poll_now(p_id);
  PERFORM operations.journal_ack(p_seq);
  RETURN true;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION delete_draft_poll(uuid, uuid, bigint) FROM PUBLIC;
--> statement-breakpoint
-- Hourly identity/retention sweep (SPEC.md §15). Idempotent; no journal needed
-- because every rule is a function of effective closure time.
CREATE FUNCTION operations.retention_sweep() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog SET lock_timeout = '2s' AS $$
DECLARE v_closed int; v_claims int; v_eligibility int; v_keys int; v_users int; v_tombstones int; v_auth int;
BEGIN
  UPDATE public.polls SET state = 'closed', closed_at = closes_at, updated_at = clock_timestamp()
    WHERE state = 'open' AND clock_timestamp() >= closes_at;
  GET DIAGNOSTICS v_closed = ROW_COUNT;
  DELETE FROM identity.claims c USING public.polls p
    WHERE c.poll_id = p.id AND p.state = 'closed' AND p.closed_at + interval '7 days' <= clock_timestamp();
  GET DIAGNOSTICS v_claims = ROW_COUNT;
  DELETE FROM identity.eligibility e USING public.polls p
    WHERE e.poll_id = p.id AND p.state = 'closed' AND p.closed_at + interval '7 days' <= clock_timestamp();
  GET DIAGNOSTICS v_eligibility = ROW_COUNT;
  -- Mark closed or withdrawn polls' private keys for destruction.
  UPDATE public.signing_keys k SET lifecycle = 'destroy_pending' FROM public.polls p
    WHERE k.poll_id = p.id AND k.lifecycle = 'active' AND (p.state = 'closed' OR p.invalidated);
  GET DIAGNOSTICS v_keys = ROW_COUNT;
  DELETE FROM identity.oauth_transactions WHERE expires_at <= clock_timestamp();
  DELETE FROM identity.sessions WHERE expires_at <= clock_timestamp();
  GET DIAGNOSTICS v_auth = ROW_COUNT;
  -- Non-organiser accounts with nothing retained that needs them.
  DELETE FROM identity.users u WHERE NOT u.is_organiser
    AND NOT EXISTS (SELECT 1 FROM identity.claims c WHERE c.user_id = u.id)
    AND NOT EXISTS (SELECT 1 FROM identity.sessions s WHERE s.user_id = u.id)
    AND NOT EXISTS (SELECT 1 FROM public.polls p WHERE p.organiser_id = u.id);
  GET DIAGNOSTICS v_users = ROW_COUNT;
  DELETE FROM operations.purge_tombstones WHERE purged_at + interval '1 year' <= clock_timestamp();
  GET DIAGNOSTICS v_tombstones = ROW_COUNT;
  RETURN jsonb_build_object('closed', v_closed, 'claims', v_claims, 'eligibility', v_eligibility,
    'keysMarked', v_keys, 'sessions', v_auth, 'users', v_users, 'tombstones', v_tombstones);
END $$;
--> statement-breakpoint
-- One-minute OAuth-transaction cleanup (and expired sessions) between hourly sweeps.
CREATE FUNCTION operations.expire_auth_state() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  DELETE FROM identity.oauth_transactions WHERE expires_at <= clock_timestamp();
  DELETE FROM identity.sessions WHERE expires_at <= clock_timestamp();
$$;
--> statement-breakpoint
CREATE FUNCTION operations.purge_candidates() RETURNS TABLE(poll_id uuid, reason text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT id, 'retention' FROM public.polls WHERE public.poll_access_expired(state, closes_at, closed_at)
  UNION ALL
  SELECT id, 'draft_expired' FROM public.polls WHERE state = 'draft' AND updated_at + interval '30 days' <= clock_timestamp()
$$;
--> statement-breakpoint
-- Takes the conflicting poll lock and reports whether the purge is due, so the
-- journal entry is written only for a change that will certainly apply.
CREATE FUNCTION operations.lock_purge_candidate(p_poll uuid, p_reason text) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog SET lock_timeout = '2s' AS $$
DECLARE v_state text; v_closes timestamptz; v_closed timestamptz; v_updated timestamptz;
BEGIN
  SELECT state, closes_at, closed_at, updated_at INTO v_state, v_closes, v_closed, v_updated
    FROM public.polls WHERE id = p_poll FOR UPDATE;
  RETURN FOUND AND ((p_reason = 'retention' AND public.poll_access_expired(v_state, v_closes, v_closed)) OR
    (p_reason = 'draft_expired' AND v_state = 'draft' AND v_updated + interval '30 days' <= clock_timestamp()));
END $$;
--> statement-breakpoint
-- Returns the private key reference (if any) so the caller removes the file after commit.
CREATE FUNCTION operations.purge_poll(p_poll uuid, p_reason text, p_seq bigint) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog SET lock_timeout = '2s' AS $$
DECLARE v_ref text;
BEGIN
  IF NOT operations.lock_purge_candidate(p_poll, p_reason) THEN
    RAISE EXCEPTION 'poll is not due for purge' USING ERRCODE = '55000';
  END IF;
  SELECT private_secret_ref INTO v_ref FROM public.signing_keys WHERE poll_id = p_poll;
  PERFORM operations.purge_poll_now(p_poll);
  PERFORM operations.journal_ack(p_seq);
  RETURN v_ref;
END $$;
--> statement-breakpoint
CREATE FUNCTION operations.lock_poll(p_poll uuid) RETURNS text
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog SET lock_timeout = '2s' AS $$
  SELECT state FROM public.polls WHERE id = p_poll FOR UPDATE
$$;
--> statement-breakpoint
-- Live keys an operator must be able to find on disk (missing-key incident check).
CREATE FUNCTION operations.live_key_refs() RETURNS TABLE(poll_id uuid, state text, private_secret_ref text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT p.id, p.state, k.private_secret_ref FROM public.polls p JOIN public.signing_keys k ON k.poll_id = p.id
   WHERE k.lifecycle = 'active' AND NOT p.invalidated AND p.state IN ('draft', 'open')
$$;
--> statement-breakpoint
CREATE FUNCTION operations.keys_pending_destruction() RETURNS TABLE(key_id uuid, private_secret_ref text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT key_id, private_secret_ref FROM public.signing_keys WHERE lifecycle = 'destroy_pending'
$$;
--> statement-breakpoint
-- Called only after the key file is unlinked and its directory fsynced.
CREATE FUNCTION operations.mark_key_destroyed(p_key uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  UPDATE public.signing_keys SET lifecycle = 'destroyed', private_secret_ref = NULL
   WHERE key_id = p_key AND lifecycle = 'destroy_pending'
$$;
--> statement-breakpoint
-- Operator-only emergency withdrawal (SPEC.md §4, §15): permanent, closes an
-- open poll, withholds results and confirmations, and schedules key destruction.
CREATE FUNCTION operations.withdraw_poll(p_poll uuid, p_reason text, p_seq bigint) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog SET lock_timeout = '2s' AS $$
DECLARE v_state text;
BEGIN
  IF p_reason NOT IN ('key_compromise','key_loss','restored_backup','integrity_failure','privacy_incident','operator') THEN
    RAISE EXCEPTION 'invalid withdrawal reason' USING ERRCODE = '22023';
  END IF;
  -- Conflicting lock: waits for admitted claims and redemptions to finish.
  SELECT state INTO v_state FROM public.polls WHERE id = p_poll FOR UPDATE;
  IF NOT FOUND THEN PERFORM operations.journal_ack(p_seq); RETURN 'absent'; END IF;
  UPDATE public.polls SET invalidated = true,
         invalidation_reason = COALESCE(invalidation_reason, p_reason),
         state = CASE WHEN state = 'open' THEN 'closed' ELSE state END,
         closed_at = CASE WHEN state = 'open' THEN LEAST(closes_at, clock_timestamp()) ELSE closed_at END,
         updated_at = clock_timestamp()
   WHERE id = p_poll;
  UPDATE public.signing_keys SET lifecycle = 'destroy_pending' WHERE poll_id = p_poll AND lifecycle = 'active';
  PERFORM operations.journal_ack(p_seq);
  RETURN 'withdrawn';
END $$;
--> statement-breakpoint
-- Operator provisioning against a verified stable identity; no public role-grant endpoint.
CREATE FUNCTION operations.set_organiser(p_issuer text, p_subject text, p_flag boolean) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  UPDATE identity.users SET is_organiser = p_flag WHERE issuer = p_issuer AND subject = p_subject;
  RETURN FOUND;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION operations.lock_purge_candidate(uuid, text), operations.lock_poll(uuid), operations.live_key_refs() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION operations.journal_seq(), operations.journal_ack(bigint), operations.retention_sweep(),
  operations.expire_auth_state(), operations.purge_candidates(), operations.purge_poll(uuid, text, bigint),
  operations.keys_pending_destruction(), operations.mark_key_destroyed(uuid), operations.withdraw_poll(uuid, text, bigint),
  operations.set_organiser(text, text, boolean) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON operations.journal_state FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'feedback_retention') THEN CREATE ROLE feedback_retention NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'feedback_operator') THEN CREATE ROLE feedback_operator NOLOGIN; END IF;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA operations TO feedback_retention, feedback_operator, feedback_portal_admin, feedback_auth;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION operations.journal_seq() TO feedback_retention, feedback_operator, feedback_portal_admin;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION operations.retention_sweep(), operations.purge_candidates(), operations.purge_poll(uuid, text, bigint),
  operations.lock_purge_candidate(uuid, text), operations.keys_pending_destruction(), operations.mark_key_destroyed(uuid) TO feedback_retention;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION operations.expire_auth_state() TO feedback_retention, feedback_auth;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION operations.withdraw_poll(uuid, text, bigint), operations.set_organiser(text, text, boolean),
  operations.lock_poll(uuid), operations.live_key_refs(),
  operations.keys_pending_destruction(), operations.mark_key_destroyed(uuid) TO feedback_operator;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION delete_draft_poll(uuid, uuid, bigint) TO feedback_portal_admin;
