-- Forward-only. Least privilege for runtime roles (SPEC.md §12, scenario 20).
-- The portal may update only draft content and lifecycle columns, never the
-- owner, withdrawal flag, IDs or policy; poll rows are created and deleted only
-- through the checked SECURITY DEFINER functions (the latter journaled).
REVOKE INSERT, DELETE, UPDATE ON polls FROM feedback_portal_admin;
--> statement-breakpoint
GRANT UPDATE (title, description, closes_at, questions, eligible_count, revision, updated_at, state, opened_at, closed_at)
  ON polls TO feedback_portal_admin;
--> statement-breakpoint
REVOKE UPDATE ON identity.eligibility FROM feedback_portal_admin;
--> statement-breakpoint
-- The issuer resolves identity and eligibility only inside identity.claim_entitlement.
REVOKE SELECT ON identity.users, identity.eligibility FROM feedback_issuer;
--> statement-breakpoint
-- Nothing is executable by PUBLIC; each role gets exactly the functions it calls.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public, identity, anonymous, operations FROM PUBLIC;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
--> statement-breakpoint
-- Read-time access boundaries used by public_polls and owner queries.
GRANT EXECUTE ON FUNCTION effective_closed_at(text, timestamptz, timestamptz), poll_access_expired(text, timestamptz, timestamptz)
  TO feedback_response_public, feedback_portal_admin;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION eligibility_expired(text, timestamptz, timestamptz) TO feedback_portal_admin;
--> statement-breakpoint
-- Trigger predicates run as whoever fires the trigger; they only answer yes/no.
GRANT EXECUTE ON FUNCTION is_table_owner(oid), poll_is_open(uuid) TO feedback_response_public, feedback_portal_admin,
  feedback_issuer, feedback_auth, feedback_closer, feedback_retention, feedback_operator, feedback_key_janitor;
--> statement-breakpoint
REVOKE USAGE ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO feedback_response_public, feedback_portal_admin, feedback_issuer, feedback_closer,
  feedback_retention, feedback_key_janitor;
--> statement-breakpoint
-- No temporary objects that could shadow names for any role without an explicit grant.
DO $$ BEGIN EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database()); END $$;
