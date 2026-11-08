-- Forward-only. Gated results (SPEC.md §11, §12): only an allowed, immutable
-- ready-result DTO is stored; no source row IDs, nullifiers, linkage arrays or
-- per-response timing. The portal never gets SELECT on responses or snapshots.
CREATE TABLE anonymous.result_snapshots (
  poll_id uuid PRIMARY KEY REFERENCES public.polls(id) ON DELETE RESTRICT,
  result jsonb NOT NULL CHECK (result->>'state' = 'ready')
);
--> statement-breakpoint
-- Owner-gated finalization: ownership first, then the conflicting closure lock
-- (waits for admitted claims/redemptions to commit or abort), then closure,
-- withdrawal, thresholds and the one-time snapshot.
CREATE FUNCTION anonymous.publish_results(p_poll uuid, p_owner uuid)
  RETURNS TABLE(outcome text, result jsonb) LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog SET lock_timeout = '2s' AS $$
DECLARE
  v_state text;
  v_invalidated boolean;
  v_closes_at timestamptz;
  v_questions jsonb;
  v_total integer;
  v_answered integer;
  v_items jsonb := '[]'::jsonb;
  v_question jsonb;
  v_snapshot jsonb;
BEGIN
  SELECT p.state, p.invalidated, p.closes_at, p.questions INTO v_state, v_invalidated, v_closes_at, v_questions
    FROM public.polls p WHERE p.id = p_poll AND p.organiser_id = p_owner FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text, NULL::jsonb; RETURN; END IF;
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
    -- Permanent: closure means no response can be added. The exact count is not disclosed.
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
      -- Each question draws its own cryptographic permutation (gen_random_uuid uses pg_strong_random).
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
REVOKE ALL ON FUNCTION anonymous.publish_results(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA anonymous TO feedback_portal_admin;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION anonymous.publish_results(uuid, uuid) TO feedback_portal_admin;
