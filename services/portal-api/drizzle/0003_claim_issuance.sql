-- Forward-only. Atomic entitlement consumption for SPEC.md §9 step 2.
-- SECURITY DEFINER so the issuer can take the §4 shared poll lock without being
-- granted UPDATE on polls, and cannot insert claims outside this locked check.
CREATE FUNCTION identity.claim_entitlement(p_poll uuid, p_user uuid, p_email text, p_key uuid)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog SET lock_timeout = '2s' AS $$
DECLARE
  v_state text;
  v_invalidated boolean;
  v_before_deadline boolean;
  v_eligibility uuid;
BEGIN
  -- Lock order: poll (FOR SHARE; conflicts with closure/invalidation), then claims.
  SELECT p.state, p.invalidated, clock_timestamp() < p.closes_at
    INTO v_state, v_invalidated, v_before_deadline
    FROM public.polls p
    JOIN public.signing_keys k ON k.poll_id = p.id AND k.key_id = p_key AND k.key_version = 1
   WHERE p.id = p_poll
     FOR SHARE OF p;
  IF NOT FOUND OR v_state = 'draft' THEN RETURN 'not_found'; END IF;
  IF v_invalidated THEN RETURN 'poll_withdrawn'; END IF;
  IF v_state <> 'open' OR NOT v_before_deadline THEN RETURN 'poll_closed'; END IF;
  -- The session's verified email must still be the account's current email.
  SELECT e.id INTO v_eligibility
    FROM identity.users u
    JOIN identity.eligibility e ON e.poll_id = p_poll AND e.email = u.email
   WHERE u.id = p_user AND u.email = p_email;
  IF NOT FOUND THEN RETURN 'not_eligible'; END IF;
  -- Both UNIQUE(poll,user) and UNIQUE(poll,eligibility) arbitrate races; a loser
  -- waits for the winner's commit and then inserts nothing.
  INSERT INTO identity.claims(poll_id, user_id, eligibility_id)
    VALUES (p_poll, p_user, v_eligibility)
    ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN 'claim_consumed'; END IF;
  RETURN 'claimed';
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION identity.claim_entitlement(uuid,uuid,text,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION identity.claim_entitlement(uuid,uuid,text,uuid) TO feedback_issuer;
--> statement-breakpoint
-- Direct inserts would bypass the locked state/deadline check.
REVOKE INSERT ON identity.claims FROM feedback_issuer;
