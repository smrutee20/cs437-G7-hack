-- Forward-only. Lost-reply recovery for a committed claim (issue #6).
-- A claim row now also stores the SHA-256 of the blinded message it was
-- issued for. The same account resending the same blinded message while the
-- poll is open is signed again; RSA blind signing is deterministic, so this
-- returns the identical blind signature and never a second credential. Any
-- other request for a consumed entitlement is still refused. Claims made
-- before this migration have no digest and cannot be retried.
ALTER TABLE identity.claims ADD COLUMN blinded_sha256 bytea
  CHECK (blinded_sha256 IS NULL OR octet_length(blinded_sha256) = 32);
--> statement-breakpoint
CREATE FUNCTION identity.claim_entitlement(p_poll uuid, p_user uuid, p_email text, p_key uuid, p_blinded_sha256 bytea)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog SET lock_timeout = '2s' AS $$
DECLARE
  v_state text;
  v_invalidated boolean;
  v_before_deadline boolean;
  v_eligibility uuid;
BEGIN
  IF p_blinded_sha256 IS NULL OR octet_length(p_blinded_sha256) <> 32 THEN
    RAISE EXCEPTION 'invalid blinded digest' USING ERRCODE = '22023';
  END IF;
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
  INSERT INTO identity.claims(poll_id, user_id, eligibility_id, blinded_sha256)
    VALUES (p_poll, p_user, v_eligibility, p_blinded_sha256)
    ON CONFLICT DO NOTHING;
  IF FOUND THEN RETURN 'claimed'; END IF;
  -- Only this account's own claim on this entry, for this exact blinded message, may be signed again.
  IF EXISTS (SELECT 1 FROM identity.claims c
              WHERE c.poll_id = p_poll AND c.user_id = p_user AND c.eligibility_id = v_eligibility
                AND c.blinded_sha256 = p_blinded_sha256) THEN
    RETURN 'reissue';
  END IF;
  RETURN 'claim_consumed';
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION identity.claim_entitlement(uuid,uuid,text,uuid,bytea) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION identity.claim_entitlement(uuid,uuid,text,uuid,bytea) TO feedback_issuer;
--> statement-breakpoint
-- The four-argument version would create claims without a digest.
DROP FUNCTION identity.claim_entitlement(uuid,uuid,text,uuid);
