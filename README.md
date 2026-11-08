# IITGN Anonymous Feedback & Polls

**Current status: Milestones 0–7 complete for local synthetic development; not approved for real participants.** Production entrypoints, Google OIDC, sessions, retention, withdrawal, backup recovery, least-privilege roles and the Feedback Booth design are implemented and tested on loopback with invented accounts. The real-participant release is **blocked** on external gates: an institutional Google OAuth client, approved hosting with compliant logging, production storage and backups, a signer container digest, and security sign-off. See [`docs/release-review.md`](docs/release-review.md) and [`docs/deployment.md`](docs/deployment.md). Nothing here establishes the privacy guarantees in `SPEC.md` for a deployment.

- [`SPEC.md`](SPEC.md): product, privacy, protocol, and release contract.
- [`PLAN.md`](PLAN.md): milestone sequence, test-first workflow, and recorded evidence.
- [`docs/deployment.md`](docs/deployment.md): operator runbook (configuration, roles, ingress, backups, recovery) and the release checklist.
- [`docs/release-review.md`](docs/release-review.md): the 27 acceptance scenarios mapped to evidence and status.
- [`design/`](design/): the Feedback Booth design reference the UI implements.

## Layout

| Path | Purpose |
| --- | --- |
| `apps/portal`, `apps/respond` | Separate browser apps: portal (sign-in, organiser workspace, results, claim bridge) and response site (anonymous form and booth). The portal also builds a separate `dist-demo` with synthetic sign-in; production builds exclude it. |
| `packages/ui` | Shared Feedback Booth components: tokens, self-hosted fonts, dot-matrix displays, plates, inputs, Booth and Press machines. CSS Modules only (CSP-safe). |
| `packages/http` | Production header set and CSP, bundle loader, HTTPS request bounds, response-host ingress stripping, startup checks. |
| `services/portal-api` | Portal API, OIDC and sessions, issuance, retention, recovery journal, operator CLI (`npm run ops`), production entrypoint `dist/server.js`, Drizzle migrations, local synthetic launcher in `dev/`. |
| `services/respond-api` | Public submission API and production entrypoint `dist/server.js` (no identity, key or signer access). |
| `services/signer` | Private native RSA-RAW blind signer for pinned `workerd` (loopback only, no outbound network). |
| `packages/protocol` | Credential byte encoding, nullifier, canonical base64url (SPEC.md §7), and the client/verifier side of RSABSSA-SHA384-PSS-Randomized. |
| `packages/config` | Origin-isolation preflight, local dev settings, and the fail-closed production configuration loader. |
| `tests/unit`, `tests/signer`, `tests/db`, `tests/browser`, `tests/demo-browser` | Vitest unit, native signer, real PostgreSQL, two-origin Playwright, and synthetic end-to-end Playwright on the production bundles. |

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
npm run test:unit      # pure encoding/validation and client blind-signature logic
npm run test:signer    # builds the signer and runs it in pinned workerd on a random loopback port
npm run test:db        # creates and drops a fresh feedback_test_* database per run; tests schema and API factories
npm run test:browser   # strict TLS check, then Chromium + Firefox against both hostnames
npm run test           # unit, signer, DB, then browser; stops at the first failing suite
FEEDBACK_ENABLE_SYNTHETIC_DEMO=yes-synthetic-only npm run test:demo-browser  # separate synthetic end-to-end suite
```

A missing database, certificate, workerd binary, or browser stops with a `SETUP ERROR` (or Playwright's install message). That means the environment is incomplete; it is not a test result.

The signer tests and browser tests both start `services/signer` in workerd with a random per-run service credential. The signer harness looks for the `linux-64` workerd binary, so other platforms need that path adjusted. npm 12 blocks workerd's postinstall script; it isn't needed, because the pinned platform binary is installed as an ordinary optional dependency.

## Synthetic local demo (not for real accounts)

The easiest way to try it is the built mode. The launcher serves the **production bundles** itself on both HTTPS origins with the production CSP and headers, plus the APIs and the pinned native signer:

```sh
npm run build
FEEDBACK_ENABLE_SYNTHETIC_DEMO=yes-synthetic-only FEEDBACK_DEMO_SERVE=built node services/portal-api/dev/demo.mjs
```

Then open `https://portal.feedback.test:4173` (see "Two origins" below for host mapping and trusting the local CA). Add `FEEDBACK_DEMO_EPHEMERAL=1` to use a fresh disposable database for the run, as the test suite does. Without it, the local database persists between runs, and each synthetic organiser is capped at 50 retained polls and ten new polls a day (SPEC.md §14).

Synthetic accounts: `organiser` and `organiser1`–`organiser6`, `student1`–`student40` (`demo-student1@iitgn.ac.in` …), and `ineligible`. These are invented test fixtures, **not** institutional accounts. Never use real identities or eligibility lists, and never deploy the dev launcher. It refuses production mode, other origins, and any database but the local one.

A walkthrough:

1. On the portal, choose **Sign in as organiser** and create a poll with 10+ of the synthetic addresses.
2. **Open poll**, which asks you to confirm the freeze, and copy the public link.
3. In another browser profile, sign in on the portal as a participant through the synthetic button (or `fetch("/__demo/login", …)` with another student), then open the public link.
4. Choose **Prepare my credential**, then **Open claim window**, then **Stamp my envelope** in the portal window. Answer and choose **Submit answers**.
5. As the organiser, **Close poll** (type `CLOSE`), then **View results**. Fewer than five responses stay permanently withheld.

For UI development, the Vite mode is still available (three terminals):

```sh
FEEDBACK_ENABLE_SYNTHETIC_DEMO=yes-synthetic-only npm run demo:api
FEEDBACK_DEMO_API=1 npm run dev -w @iitgn-feedback/portal
FEEDBACK_DEMO_API=1 npm run dev -w @iitgn-feedback/respond
```

The demo keeps its local journal, keys and secrets in `.certs/` (untracked), applies the same journal/database agreement rule as production, and schedules the deadline closer and retention. `npm run test:browser` starts its own Vite servers, so stop any demo first or the ports conflict.

## Production entrypoints and operations

`node services/portal-api/dist/server.js` and `node services/respond-api/dist/server.js` read only environment variables and secret files, and refuse to start on any unsafe setting. Try them without configuration to see the checks. `npm run ops -- <migrate|init-journal|check-sync|withdraw|check-keys|provision-organiser|revoke-organiser|retention|recover>` is the operator CLI. Configuration, roles, ingress and logging requirements, backups and the recovery procedure are in [`docs/deployment.md`](docs/deployment.md).

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
