-- Forward-only. Anonymous responses (SPEC.md §10, §12): no user, eligibility,
-- claim, request, sequence or timestamp column. Poll ID is the only grouping key.
CREATE TABLE anonymous.responses (
  poll_id uuid NOT NULL REFERENCES public.polls(id) ON DELETE RESTRICT,
  nullifier bytea NOT NULL CHECK (octet_length(nullifier) = 32),
  answers jsonb NOT NULL CHECK (jsonb_typeof(answers) = 'array' AND jsonb_array_length(answers) > 0),
  PRIMARY KEY (poll_id, nullifier)
);
--> statement-breakpoint
-- Lock order (§4): poll FOR SHARE, then the poll/nullifier advisory lock, then
-- the response row. Each statement below reads a fresh READ COMMITTED snapshot,
-- so the lookup after the advisory lock sees any earlier committed acceptance.
CREATE FUNCTION anonymous.redeem(p_poll uuid, p_nullifier bytea, p_answers jsonb)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog SET lock_timeout = '2s' AS $$
DECLARE
  v_state text;
  v_invalidated boolean;
  v_closes_at timestamptz;
  v_existing jsonb;
BEGIN
  IF p_nullifier IS NULL OR octet_length(p_nullifier) <> 32 OR p_answers IS NULL THEN
    RAISE EXCEPTION 'invalid redemption input' USING ERRCODE = '22023';
  END IF;
  SELECT state, invalidated, closes_at INTO v_state, v_invalidated, v_closes_at
    FROM public.polls WHERE id = p_poll FOR SHARE;
  IF NOT FOUND OR v_state = 'draft' THEN RETURN 'not_found'; END IF;
  IF v_invalidated THEN RETURN 'poll_withdrawn'; END IF;
  -- First 8 bytes of SHA256("IITGN-FEEDBACK-REDEEM-LOCK\0" || UUID_BYTES(poll) || nullifier), big-endian signed.
  PERFORM pg_advisory_xact_lock(('x' || encode(substring(sha256(
    convert_to('IITGN-FEEDBACK-REDEEM-LOCK', 'UTF8') || '\x00'::bytea || uuid_send(p_poll) || p_nullifier
  ) FROM 1 FOR 8), 'hex'))::bit(64)::bigint);
  -- Existing responses are confirmed before ordinary closure is considered.
  SELECT answers INTO v_existing FROM anonymous.responses WHERE poll_id = p_poll AND nullifier = p_nullifier;
  IF FOUND THEN
    RETURN CASE WHEN v_existing = p_answers THEN 'replayed' ELSE 'credential_spent' END;
  END IF;
  -- The acceptance decision: state and deadline checked immediately before insertion.
  IF v_state <> 'open' OR clock_timestamp() >= v_closes_at THEN RETURN 'poll_closed'; END IF;
  INSERT INTO anonymous.responses(poll_id, nullifier, answers) VALUES (p_poll, p_nullifier, p_answers)
    ON CONFLICT DO NOTHING;
  IF FOUND THEN RETURN 'inserted'; END IF;
  SELECT answers INTO v_existing FROM anonymous.responses WHERE poll_id = p_poll AND nullifier = p_nullifier;
  RETURN CASE WHEN v_existing = p_answers THEN 'replayed' ELSE 'credential_spent' END;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION anonymous.redeem(uuid, bytea, jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA anonymous TO feedback_response_public;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION anonymous.redeem(uuid, bytea, jsonb) TO feedback_response_public;
