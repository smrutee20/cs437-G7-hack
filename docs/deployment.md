# Deployment and operations runbook

**Deployment:** A single-instance Lightsail proof of concept serves both HTTPS origins; its concrete configuration and operational commands are in [`aws-deployment.md`](aws-deployment.md). The local acceptance evidence below does not validate the privacy guarantees of that deployment. [`SPEC.md`](../SPEC.md) §18 forbids real participants until the release checklist at the end is complete. Where this runbook says "must", the requirement comes from the spec; where it says "not verified", nobody has checked it on real infrastructure.

## 1. Topology

| Process | Listens on | Database login (member of exactly) | Holds |
| --- | --- | --- | --- |
| Portal (`services/portal-api/dist/server.js`) | portal HTTPS host | `FEEDBACK_PORTAL_DB_URL` → `feedback_portal_admin`; `FEEDBACK_ISSUER_DB_URL` → `feedback_issuer`; `FEEDBACK_AUTH_DB_URL` → `feedback_auth`; `FEEDBACK_CLOSER_DB_URL` → `feedback_closer`; `FEEDBACK_RETENTION_DB_URL` → `feedback_retention` | Google client secret, key-encryption key, cursor key, signer token, encrypted private-key directory, recovery journal |
| Response (`services/respond-api/dist/server.js`) | response HTTPS host | `FEEDBACK_RESPOND_DB_URL` → `feedback_response_public` | TLS key only. Startup refuses any identity, key, signer or portal setting. |
| Native signer (`services/signer`, pinned `workerd`) | `127.0.0.1` only | none | Per-run service token; no outbound network |
| Operator CLI (`npm run ops`) | none | `FEEDBACK_OPERATOR_DB_URL` → `feedback_operator`; `FEEDBACK_RETENTION_DB_URL`; `FEEDBACK_MIGRATION_DB_URL` (owner, deployment-only) | Same journal and key directory as the portal |

Each server serves its own built bundle (`apps/<app>/dist`, or `FEEDBACK_FRONTEND_DIRECTORY`) and its own `/api/v1`, with the exact CSP and header set from `packages/http`. The portal also schedules the deadline closer (1 min), retention plus the orphan-key sweep (hourly and at start), and OAuth/session cleanup (30 s). Each runs on its own database role.

## 2. Fail-closed startup

`packages/config/src/production.ts` refuses, naming variables but never values:

- `NODE_ENV` other than `production`;
- the same, nested, HTTP, wildcard or development (`.test`, `.localhost`, …) hostnames;
- any demo, `MIN_`, `SKIP_`, `DISABLE_` or `ALLOW_` switch;
- a different institutional domain;
- `GOOGLE_SDK_NODE_LOGGING`, `NODE_DEBUG`, or `NODE_OPTIONS` inspection, profiling or report flags;
- shared database roles;
- off-host databases without `sslmode=verify-full`;
- a non-loopback signer.

The servers then refuse to listen unless all of these hold:

- secret files are not group- or world-readable;
- the key directory is `0700` and owned by the process user;
- every database login is non-privileged, owns nothing, and is a member of **exactly** its role, with `fsync` and `synchronous_commit` on;
- the recovery journal and the database agree;
- the signer is healthy;
- the bundle has no demo login and no inline script or style.

`npm run build` runs the same bundle check.

## 3. Database

1. PostgreSQL 17 with `fsync=on` and `synchronous_commit=on`, on durable (non-ephemeral) storage. Use TLS (`sslmode=verify-full`) for any off-host connection.
2. Logging must not retain request data. Use the settings in [`compose.yaml`](../compose.yaml): `log_statement=none`, `log_min_error_statement=panic`, `log_min_messages=fatal`, `log_error_verbosity=terse`, `log_parameter_max_length*=0`, `log_min_duration_statement=-1`, and connection logging off. Disable `auto_explain`, `pg_stat_statements` sampling exports, and any provider "query insights" that keeps statement text. **Not verified on a managed service.**
3. Apply migrations with the deployment-only owner credential, which is never given to a running service:

   ```sh
   FEEDBACK_MIGRATION_DB_URL=postgresql://owner@db/feedback?sslmode=verify-full npm run ops -- migrate
   ```

4. Create one login per service role. Do not grant a login two runtime roles: startup refuses it.

   ```sql
   CREATE ROLE feedback_portal_login LOGIN PASSWORD '…' NOSUPERUSER NOCREATEDB NOCREATEROLE IN ROLE feedback_portal_admin;
   CREATE ROLE feedback_issuer_login LOGIN PASSWORD '…' IN ROLE feedback_issuer;
   CREATE ROLE feedback_auth_login LOGIN PASSWORD '…' IN ROLE feedback_auth;
   CREATE ROLE feedback_closer_login LOGIN PASSWORD '…' IN ROLE feedback_closer;
   CREATE ROLE feedback_retention_login LOGIN PASSWORD '…' IN ROLE feedback_retention;
   CREATE ROLE feedback_respond_login LOGIN PASSWORD '…' IN ROLE feedback_response_public;
   CREATE ROLE feedback_operator_login LOGIN PASSWORD '…' IN ROLE feedback_operator;
   ```

   `tests/db/privileges.test.ts` pins what each role can do.

## 4. Secrets and keys

| Setting | Content |
| --- | --- |
| `FEEDBACK_KEY_ENCRYPTION_KEY_FILE`, `FEEDBACK_CURSOR_KEY_FILE` | 32 random bytes, raw or unpadded base64url. Mode `0600`. Back the key-encryption key up separately from the database. |
| `FEEDBACK_KEY_DIRECTORY` | `0700` directory for per-poll AES-256-GCM-encrypted PKCS#8 files. It must be on durable, encrypted storage, separate from PostgreSQL and the web roots. |
| `FEEDBACK_SIGNER_TOKEN_FILE` | ≥ 32 characters, shared only with the signer. |
| `FEEDBACK_GOOGLE_CLIENT_SECRET_FILE` | The Google OAuth client secret. |
| `FEEDBACK_TLS_CERT_FILE`, `FEEDBACK_TLS_KEY_FILE` | Certificate for the exact hostname. |
| `FEEDBACK_JOURNAL_PATH` | The append-only recovery journal (§7), on storage **outside the database's backup and rollback domain**. |

Before first start: `npm run ops -- init-journal` (creates an empty journal and never replaces one).

## 5. Host and process hardening (not verified)

- **Core dumps off and no unencrypted swap.** For example, in systemd: `LimitCORE=0`, plus host swap disabled or encrypted.
- **No crash reporter, APM or profiler** that captures heap, request bodies or headers.
- Suggested unit settings: `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp=yes`, `ReadWritePaths=` limited to the key directory and journal, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`, and `StandardOutput=null` (the services print nothing at runtime; startup failures print one `SETUP ERROR` line).
- **Signer.** Run the pinned `workerd` (`@cloudflare/workerd-linux-64@1.20261023.1`) with `services/signer/config.capnp`, bound to `127.0.0.1`, with no outbound network. **A container image and digest are not selected** (release blocker). The BoringSSL private operation has no RSA blinding (constant-time CRT with a fault check); this needs **security sign-off** (release blocker).

## 6. Ingress, CDN and WAF (not verified)

- TLS 1.2+ on exactly two approved hostnames, with HSTS once validated. Never serve one app from the other's host.
- Enforce the same bounds the application does: 8 KiB of headers, 2 KiB URIs, the per-route body limits (256 KiB draft, 2 KiB claim, 64 KiB response), a 5 s body receive time, and refused compressed request bodies.
- **Response host:** strip `Cookie`, `Authorization`, client-IP/forwarding headers (`Forwarded`, `X-Forwarded-*`, `True-Client-IP`, `CF-Connecting-IP`, …), `User-Agent` and client hints, trace/baggage headers and request IDs **before** the application (it strips them too, as defense in depth). Never add cookies.
- **Logging:** disable request logs for the **entire response origin** at every layer (edge, CDN, WAF, load balancer). For the portal, disable request, query and body logging on `/api/v1/auth/*`, `/claim-bridge` and `/api/v1/polls/*/claim`. No WAF payload sampling, no analytics, no correlation IDs. Real hosting that cannot do this is **not approved for real participants** (§15).
- Do not cache HTML or API responses. Hashed `/assets/*` may be cached.

## 7. Operations

All commands print counts and poll IDs only.

| Task | Command |
| --- | --- |
| Check journal/database agreement | `npm run ops -- check-sync` |
| Grant or revoke the organiser role (account must have signed in once) | `npm run ops -- provision-organiser <google-sub>` / `revoke-organiser <google-sub>` |
| Emergency withdrawal | `npm run ops -- withdraw <pollId> <key_compromise\|key_loss\|integrity_failure\|privacy_incident\|operator>` |
| Missing-key incident check | `npm run ops -- check-keys [--withdraw]` |
| Run retention now (also scheduled hourly) | `npm run ops -- retention` |

**Withdrawal** writes the journal entry first, then (under the conflicting poll lock, after admitted claims and redemptions finish) closes and invalidates the poll. It permanently withholds results and confirmations and destroys the private key. It cannot be undone. Notify the organiser and, where possible, the whole eligible group or public audience; never only claimed or responded users.

**Retention** (SPEC.md §15), enforced at read time even if a run is late:

- eligibility and claims are purged 7 days after effective closure;
- private keys are destroyed on the next hourly run after closure;
- everything else becomes not found at 90 days, then is purged to a tombstone;
- unedited drafts are deleted after 30 days;
- OAuth transactions and sessions are deleted once expired;
- non-organiser users are deleted when nothing retained needs them;
- tombstones are deleted after 1 year.

Every purge is journaled.

## 8. Backup and restore (procedure tested locally; tooling not chosen)

- Encrypted PostgreSQL backups and WAL archive, **rolling 7-day maximum**. Back up the key directory and key-encryption key separately. The journal needs its own durable copy, kept at least as long as the oldest restorable backup (1 year per §15).
- **Restore:**
  1. Keep ingress disabled. The servers refuse to start anyway, because a restored database no longer matches the journal.
  2. Restore the database.
  3. Run `FEEDBACK_MIGRATION_DB_URL=… FEEDBACK_JOURNAL_PATH=… FEEDBACK_KEY_DIRECTORY=… npm run ops -- recover [--withdraw-closed]`. Recovery:
     - replays every withdrawal and purge;
     - applies tombstones;
     - withdraws **every poll that was open** in the restored database (a rollback may have forgotten claims or nullifiers);
     - withdraws closed polls that look inconsistent (or all closed polls with `--withdraw-closed`, which is the choice when uncertain);
     - applies retention;
     - destroys affected keys;
     - re-acknowledges the journal.

     A missing, torn, truncated or edited journal stops recovery. Keep the deployment offline, or start a new empty one.
  4. `npm run ops -- check-sync`, then start the services.
  5. Document what was lost.
- Exercised by `tests/db/operations.test.ts` on a real database copy, not with production backup tooling.

## 9. Release checklist (SPEC.md §18)

| Gate | Status |
| --- | --- |
| Institutional OAuth client authorised; real signed `email`/`hd` claims observed | **Blocked for release**: Google Web client configured and redirect tested, but no institutional sign-in/token verified yet. |
| Two approved HTTPS hostnames; logging-compliant ingress/CDN/WAF | Two hostnames live on Lightsail with Caddy (no access log); full ingress/privacy review not done. |
| Durable PostgreSQL and encrypted private-key store; 7-day encrypted backups | PostgreSQL and encrypted keys on Lightsail disk; off-instance encrypted backups not configured. |
| Signer container image and digest; security sign-off on the no-blinding private operation | **Blocked**. |
| Signer service-credential provisioning and rotation | Not done (per-run token in the demo only). |
| CI executed on a real remote | Done for synthetic/local validation: all six jobs passed on `main` ([run 42506531372](https://github.com/nishchaybhutoria/iitgn-feedback-booth/actions/runs/42506531372)); no deployed infrastructure was tested. |
| Production mock-auth exclusion | Done: separate demo build, startup and build-time bundle checks, config refusals. |
| All 27 acceptance scenarios | Local/synthetic evidence for all but scenario 1 (real login); see [`release-review.md`](release-review.md). |
| Recovery and withdrawal procedure exercised | Locally only (template copy of a real database). |
