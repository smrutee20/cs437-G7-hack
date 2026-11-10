# Release review (Milestone 7)

Reviewed 2026-11-08 on branch `foundation-feasibility`.

**Verdict at review time: the synthetic local demo meets its exit criteria. A real-participant release is blocked.** Since this review, the two HTTPS origins and a Google Web OAuth client have been configured on Lightsail; institutional login, off-instance backups, ingress/privacy review, a signer image digest and security sign-off are still outstanding. The test evidence below is from loopback with invented accounts, not from the deployed infrastructure. See [aws-deployment.md](aws-deployment.md) for deployment observations.

## Evidence run

All on one machine (Node 24.19.0, PostgreSQL 17 in Compose, Chromium 158.0.8127.18, Firefox 159.0):

| Command | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm run build` (plus the production-bundle gate) | pass: portal and respond bundles contain no demo login or inline script/style |
| `npm run test:unit` | 176/176 |
| `npm run test:signer` (pinned `workerd`, native `RSA-RAW`) | 31/31 |
| `npm run test:db` (real PostgreSQL, per-run database) | 79/79 (+1 skipped diagnostic) |
| `npm run test:browser` (Chromium and Firefox, two HTTPS hostnames) | 68/68; redesigned flows `--repeat-each=3`: 182/182 |
| `FEEDBACK_ENABLE_SYNTHETIC_DEMO=yes-synthetic-only npm run test:demo-browser` (production bundles, enforced CSP, disposable DB) | 10/10 |
| `npm audit --audit-level=moderate` | 0 vulnerabilities |

## Acceptance scenarios (SPEC.md §17)

"Local" means demonstrated against real PostgreSQL, real browsers and the native signer on loopback, with synthetic identities.

| # | Scenario | Evidence | Status |
| --- | --- | --- | --- |
| 1 | OIDC verification and login failures | `tests/db/oidc.test.ts`: local RS256 IdP covering 18 token failures, reused state, login CSRF, expiry, unsafe return paths, valid login. 9 mutants killed. | **Blocked for release**: client configured, but no institutional token verified |
| 2 | Stable `(issuer, sub)`; alternate/reassigned addresses | `oidc.test.ts` (email change keeps the user), `claim.test.ts` (renamed account, reassigned address, stale session email) | Local |
| 3 | Organiser isolation, mass assignment | `portal-api.test.ts`, `results-api.test.ts`, `delete-draft.test.ts`, `privileges.test.ts` (the portal role cannot change owner or withdrawal at the DB level) | Local |
| 4 | CSRF/Origin on every mutation; no mock login or relaxed policy in production | `csrf-routes.test.ts` (7 routes × 5 variants), `production-config.test.ts`, `production-server.test.ts`, build bundle gate | Local |
| 5 | RFC 9474 vectors, encoding fixture, native signer, interop | `blind.test.ts`, `credential.test.ts`, `tests/signer/*`, `blind-interop.spec.ts` | Local; signer image digest and security review **blocked** |
| 6 | Hidden cross-poll message | `claim.test.ts`, `redeem.test.ts` | Local |
| 7 | Malformed credentials and answers | `redeem.test.ts`, `respond-api.test.ts`, `answers.test.ts` | Local |
| 8 | Concurrent claims; crash windows | `claim.test.ts` (8-way and shared-entry races; lost commit ack; killed backend; post-commit signer failure) | Local |
| 9 | No issuance for draft/closed/expired/withdrawn; restart keeps keys | `claim.test.ts`, `claim-api.test.ts`, `operations.test.ts` | Local |
| 10 | Redemption races, one nullifier | `redeem.test.ts` | Local |
| 11 | Answer validation and idempotency | `answers.test.ts`, `redeem.test.ts` | Local |
| 12 | Lost ack, deadline-crossing retry | `redeem.test.ts`, `submit.spec.ts` | Local |
| 13 | Claim/submit vs close/deadline/invalidation/publication | `poll-lifecycle.test.ts`, `claim.test.ts`, `redeem.test.ts`, `results.test.ts`, `operations.test.ts`; deadline enforced with the scheduler stopped | Local |
| 14 | Revision conflicts; frozen content; no reopening | `poll-lifecycle.test.ts`, `foundation.test.ts`, `privileges.test.ts` | Local |
| 15 | Cookie and hostname isolation | `origins.spec.ts`, `origins.test.ts`, `production-server.test.ts` (response host strips cookies and sets none), `poll-foundation.spec.ts` | Local tests; public hostnames live but full isolation review pending |
| 16 | Bridge spoofing, popups, interruptions | `bridge.spec.ts`, `claim.spec.ts`, `claim-interruptions.spec.ts`, `popup-blocker.spec.ts` | Local (gaps below) |
| 17 | Browser storage across states | `claim.spec.ts`, `submit.spec.ts`, `draft.spec.ts` | Local |
| 18 | Hostile content; CSP; opener in real builds | `results.spec.ts`, `poll-content.spec.ts`, `csp.spec.ts` (production bundles, zero violations, enforcement proven) | Local |
| 19 | Persistence and log review | `logging.test.ts`, `foundation.test.ts`, `results.test.ts`, signer log check | Local; ingress/CDN/WAF **blocked** |
| 20 | Runtime role privileges | `privileges.test.ts` (exact sets; found and fixed real over-grants) | Local |
| 21 | Original v1 thresholds at 0/4/5 | Historical local evidence; new v2 single-response tests in `results.test.ts` | Local |
| 22 | Aggregation, rounding, shuffles, JSON shape | `results.test.ts`, `results-api.test.ts` | Local |
| 23 | Immutable policy, no export, permanent withholding, withdrawal, purge | `results.test.ts`, `results-api.test.ts`, `operations.test.ts` | Local |
| 24 | Limits, overload, limiter privacy | `respond-admission.test.ts`, `claim-admission.test.ts`, `respond-api.test.ts`, `draft-limits.test.ts`, `http-bounds.test.ts`, `production-server.test.ts` (414/431) | Local; no load test |
| 25 | Retention boundaries | `operations.test.ts`, `submit.spec.ts` (browser expiry) | Local; backup expiry is procedure only |
| 26 | Stale backup restore, key loss/compromise | `operations.test.ts` (real database template copy) | Local; production backup tooling **blocked** |
| 27 | Synthetic walkthrough (ten eligible, five responses, withheld four under v1) | Historical result; v2 now publishes even with one response; `results.spec.ts` exercises small polls under CSP | **Done** (synthetic) |

## Known gaps (not hidden by any test)

- A response tab closed mid-claim is not explicitly tested; the bridge erases its result after two minutes either way.
- There is no handshake timeout while waiting for `bridge_ready`/`bridge_ack`; only window closure ends the wait.
- The response route's verification-semaphore wiring and `ON CONFLICT` under the advisory lock are equivalent-mutant survivors, kept as defense in depth.
- Follow-up after merging to `main`: all six CI jobs passed on the private remote ([run 42506531372](https://github.com/nishchaybhutoria/iitgn-feedback-booth/actions/runs/42506531372)). CI uses synthetic data and does not verify a production deployment.
- No accessibility audit with assistive technology; desktop only, as the spec states.
- No load test or measured throughput.
- Journal compaction after one year is not implemented.

See [`deployment.md`](deployment.md) for the operator runbook and the release checklist.
