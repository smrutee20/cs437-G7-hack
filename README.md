# IITGN Anonymous Feedback & Polls

**Current status: Milestone 2 complete for local synthetic development; Milestones 3–5 (anonymous claim, submission and gated results) complete for synthetic accounts; Milestone 6 (production boundaries) has not started. Not ready for participants or deployment.** The demo login uses invented accounts only. There is no production authentication, deployment hardening, or retention/recovery operations. The native signer is a feasibility proof, not a deployed service. Nothing here establishes the privacy guarantees in `SPEC.md`.

- [`SPEC.md`](SPEC.md): product, privacy, protocol, and release contract.
- [`PLAN.md`](PLAN.md): milestone sequence, test-first workflow, and recorded evidence.

## Layout

| Path | Purpose |
| --- | --- |
| `apps/portal`, `apps/respond` | Separate browser apps: synthetic organiser draft/lifecycle UI and public read-only poll page; legacy claim-bridge spike remains synthetic. |
| `services/portal-api`, `services/respond-api` | Separate API factories for owner poll lifecycle and public metadata. Portal contains Drizzle migrations, validation, encrypted per-poll key provisioning, and a separate local-only synthetic launcher in `dev/`; no production auth/listener. |
| `services/signer` | Private native RSA-RAW blind signer for pinned `workerd` (loopback only, no outbound network). |
| `packages/protocol` | Credential byte encoding, nullifier, canonical base64url (SPEC.md §7), and the client/verifier side of RSABSSA-SHA384-PSS-Randomized. |
| `packages/config` | Fail-closed portal/response origin-isolation preflight and local dev-server settings. |
| `tests/unit`, `tests/db`, `tests/browser`, `tests/demo-browser` | Vitest unit, Vitest + real PostgreSQL, origin/crypto Playwright, and synthetic poll workflow Playwright suites. |

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

## Synthetic local organiser demo (not for real accounts)

After local setup, use **three terminals**. No production OIDC, submission or results are connected. Run `npm run build` first: `demo:api` also starts the pinned native signer on loopback port 5186 with a fresh service credential.

```sh
FEEDBACK_ENABLE_SYNTHETIC_DEMO=yes-synthetic-only npm run demo:api
FEEDBACK_DEMO_API=1 npm run dev -w @iitgn-feedback/portal
FEEDBACK_DEMO_API=1 npm run dev -w @iitgn-feedback/respond
```

Visit the portal URL below and choose **Sign in as organiser**. The launcher accepts only explicitly named synthetic actors (`organiser`, `student1`–`student40`, `ineligible`), binds loopback listeners and the disposable local database, and refuses production mode/other origins. It seeds synthetic identities and separate runtime DB logins. The portal cookie never reaches the response hostname. Import 10–1,000 institutional-format *invented* email addresses; `demo-student1@iitgn.ac.in` through `demo-student40@iitgn.ac.in` are test fixtures, **not** institutional accounts. The preview does not issue a credential or save an answer. Open/close is irreversible.

To try a claim, sign in on the portal as a synthetic participant (for example `student1`), open the poll's public link on the response site, choose **Prepare credential**, then **Open claim window** and confirm in the portal window. The credential stays in that browser's IndexedDB. Each account can claim once per poll. Answer the questions and choose **Submit answers**; the response service needs no sign-in and stores only the poll ID, a nullifier and the canonical answers. After closing a poll, the organiser can choose **View results**: fewer than five responses are permanently withheld, and each question needs five answers.

The demo scheduler materializes deadline closure on startup and every minute. It is not a substitute for production monitoring, recovery, retention, or private-key deletion. Restarting the demo invalidates in-memory sessions; `.certs/demo-*` hold local keys outside Git. Do **not** use real identities, eligibility lists, or deploy the dev launcher. `npm run test:browser` starts independent Vite servers; stop any manually running Vite demo servers before running it or the ports will conflict. The separate demo-browser runner can start its own services when the flag above is supplied.

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
