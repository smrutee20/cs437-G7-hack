-- Forward-only. Portal OIDC transactions and server-side sessions (SPEC.md §5, §12).
-- No raw OAuth tokens, session tokens or state values are stored: only hashes.
CREATE TABLE identity.oauth_transactions (
  state_hash bytea PRIMARY KEY CHECK (octet_length(state_hash) = 32),
  preauth_hash bytea NOT NULL CHECK (octet_length(preauth_hash) = 32),
  nonce text NOT NULL CHECK (nonce ~ '^[A-Za-z0-9_-]{43}$'),
  pkce_verifier text NOT NULL CHECK (pkce_verifier ~ '^[A-Za-z0-9_-]{43}$'),
  return_path text NOT NULL CHECK (return_path IN ('/', '/signed-in')),
  expires_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX oauth_transactions_expiry ON identity.oauth_transactions (expires_at);
--> statement-breakpoint
CREATE TABLE identity.sessions (
  token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  email text NOT NULL,
  csrf_token text NOT NULL CHECK (csrf_token ~ '^[A-Za-z0-9_-]{43}$'),
  expires_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX sessions_expiry ON identity.sessions (expires_at);
--> statement-breakpoint
CREATE INDEX sessions_user ON identity.sessions (user_id);
--> statement-breakpoint
-- Binds an application user to (issuer, subject); email is an updatable attribute.
-- The organiser flag is operator-managed and never set here.
CREATE FUNCTION identity.upsert_verified_user(p_issuer text, p_subject text, p_email text)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_id uuid;
BEGIN
  IF p_issuer IS DISTINCT FROM 'https://accounts.google.com' OR p_subject IS NULL OR p_subject = ''
     OR length(p_subject) > 255 OR p_email IS NULL OR p_email !~ '^[a-z0-9._+-]{1,64}@iitgn\.ac\.in$' THEN
    RAISE EXCEPTION 'invalid verified identity' USING ERRCODE = '22023';
  END IF;
  INSERT INTO identity.users(id, issuer, subject, email) VALUES (gen_random_uuid(), p_issuer, p_subject, p_email)
    ON CONFLICT (issuer, subject) DO UPDATE SET email = EXCLUDED.email
    RETURNING id INTO v_id;
  RETURN v_id;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION identity.upsert_verified_user(text, text, text) FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'feedback_auth') THEN
    CREATE ROLE feedback_auth NOLOGIN;
  END IF;
END $$;
--> statement-breakpoint
REVOKE ALL ON identity.oauth_transactions, identity.sessions FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA identity TO feedback_auth;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON identity.oauth_transactions TO feedback_auth;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON identity.sessions TO feedback_auth;
--> statement-breakpoint
GRANT SELECT (id, is_organiser) ON identity.users TO feedback_auth;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION identity.upsert_verified_user(text, text, text) TO feedback_auth;
