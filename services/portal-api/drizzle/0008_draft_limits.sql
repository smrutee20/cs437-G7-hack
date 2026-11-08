-- Forward-only. SPEC.md §14: at most 50 retained polls per organiser, enforced
-- under a per-owner row lock so concurrent creations cannot overshoot.
CREATE OR REPLACE FUNCTION create_draft_poll(
  p_id uuid, p_owner uuid, p_title text, p_description text, p_closes_at timestamptz,
  p_questions jsonb, p_key_id uuid, p_public_jwk jsonb, p_fingerprint bytea,
  p_private_ref text, p_emails text[]
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM 1 FROM identity.users WHERE id = p_owner AND is_organiser FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not an organiser' USING ERRCODE = '42501';
  END IF;
  IF (SELECT count(*) FROM public.polls WHERE organiser_id = p_owner) >= 50 THEN
    RAISE EXCEPTION 'retained poll limit' USING ERRCODE = '54000';
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
-- The scheduled orphan-key sweep runs under the retention role: key IDs only.
GRANT USAGE ON SCHEMA public TO feedback_retention;
--> statement-breakpoint
GRANT SELECT (key_id) ON signing_keys TO feedback_retention;
