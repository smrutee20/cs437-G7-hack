-- Expose the frozen eligible count publicly so the response page can warn
-- before a claim when very few people can respond (issue #4). Same view as
-- 0007 with eligible_count appended; existing grants are kept.
CREATE OR REPLACE VIEW public_polls WITH (security_barrier = true) AS
  WITH deadline_clock AS MATERIALIZED (SELECT clock_timestamp() AS instant)
  SELECT p.id,p.title,p.description,
         CASE WHEN p.state = 'open' AND deadline_clock.instant >= p.closes_at THEN 'closed' ELSE p.state END AS state,
         p.invalidated,p.opened_at,
         CASE WHEN p.state = 'open' AND deadline_clock.instant >= p.closes_at THEN p.closes_at ELSE p.closed_at END AS closed_at,
         p.closes_at,p.questions,p.policy_version,k.key_id,k.key_version,k.suite,k.public_jwk,
         p.eligible_count
  FROM polls p JOIN signing_keys k ON k.poll_id = p.id CROSS JOIN deadline_clock
  WHERE p.state <> 'draft' AND NOT public.poll_access_expired(p.state, p.closes_at, p.closed_at);
