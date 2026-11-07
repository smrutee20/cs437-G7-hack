# IITGN Anonymous Feedback & Polls

**Current status: foundation and feasibility work (PLAN.md Milestones 0–1). Not ready for participants or deployment.** There is no authentication, signing service, submission, database schema, or results endpoint yet. Nothing here establishes the privacy guarantees in `SPEC.md`.

- [`SPEC.md`](SPEC.md): product, privacy, protocol, and release contract.
- [`PLAN.md`](PLAN.md): milestone sequence, test-first workflow, and recorded evidence.

## Layout

| Path | Purpose |
| --- | --- |
| `apps/portal`, `apps/respond` | Separate browser apps for the two origins (scaffold pages only). |
| `services/portal-api`, `services/respond-api` | Separate API packages (empty Fastify factories, no listeners). |
| `packages/protocol` | Credential byte encoding, nullifier, canonical base64url (SPEC.md §7). |
| `packages/config` | Fail-closed portal/response origin-isolation preflight and local dev-server settings. |
| `tests/unit`, `tests/db`, `tests/browser` | Vitest unit, Vitest + real PostgreSQL, and Playwright suites. |

## Local setup

Prerequisites: Node.js 24 + npm, Docker with Compose, and `openssl`.

```sh
npm ci
scripts/create-dev-certs.sh                    # local CA + cert for both hostnames, in .certs/ (untracked)
docker compose up -d --wait postgres           # disposable PostgreSQL 17 on 127.0.0.1:55432
npx playwright install chromium firefox        # first run only
```

## Checks

```sh
npm run typecheck      # all workspaces, plus tests and tooling configs
npm run build
npm run test:unit      # pure encoding/validation
npm run test:db        # creates and drops a fresh feedback_test_* database per run
npm run test:browser   # strict TLS check, then Chromium + Firefox against both hostnames
npm run test           # unit, then DB, then browser; stops at the first failing suite
```

A missing database, certificate, or browser stops with a `SETUP ERROR` (or Playwright's install message). That means the environment is incomplete; it is not a test result.

## Two origins

The portal and response apps must run on **distinct HTTPS hostnames**. Cookies aren't isolated by port (RFC 6265 §8.5), so a same-host/different-port setup is rejected at startup:

| App | Default origin | Override |
| --- | --- | --- |
| Portal | `https://portal.feedback.test:4173` | `FEEDBACK_PORTAL_ORIGIN` |
| Response | `https://respond.feedback.test:4174` | `FEEDBACK_RESPOND_ORIGIN` |

The automated browser tests map both names to loopback inside the browser, so they don't need `/etc/hosts` changes. They ignore certificate errors in the browser only. A separate setup test checks each hostname's certificate against `.certs/dev-ca.crt`, with no bypass.

For **interactive** browsing (`npm run dev -w @iitgn-feedback/portal`, and the same for `respond`):

1. Add `127.0.0.1 portal.feedback.test respond.feedback.test` to `/etc/hosts` (requires sudo).
2. Trust `.certs/dev-ca.crt` in a **development browser profile only**. In Firefox: Settings → Privacy & Security → Certificates → View Certificates → Authorities → Import. In Chromium: Settings → Privacy and security → Security → Manage certificates → Authorities → Import. Remove it when you're done. Never trust it system-wide on a machine used for real accounts.
3. Check from a shell: `curl --cacert .certs/dev-ca.crt https://portal.feedback.test:4173/`.

The local CA key in `.certs/` can issue certificates for any name your browser will trust while the CA is imported. Keep the directory private (it is created `0700`), and never use it for real users.

## Teardown

```sh
docker compose down -v   # stops PostgreSQL and deletes its volume
```
