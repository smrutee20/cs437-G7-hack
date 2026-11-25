# Feedback Booth — coding agent guide

This repository runs IITGN Feedback Booth: a signed-in portal for poll setup and credential issuance, and a separate response site for submissions. Start with `SPEC.md` for the product and privacy contract. Use `docs/release-review.md` to find acceptance evidence and `docs/deployment.md` for operational procedures. If the code and spec disagree, flag the discrepancy instead of silently choosing one.

## Boundaries to preserve

- **Portal vs. response:** `apps/portal` and `services/portal-api` own sign-in and issuance. `apps/respond` and `services/respond-api` handle answers without portal sessions, cookies, or identity fields. Keep the two HTTPS hostnames distinct. Don't add shared identifiers, analytics, or logs that can link claims to answers.
- **Public vs. organiser data:** Keep eligibility counts and addresses, claim status, raw responses, and identity fields out of public poll data. Consult `SPEC.md` §13 before adding any API field; an organiser-only field is not automatically safe on the response site.
- **Publication and wording:** Use the poll's frozen policy when deciding what can publish. Don't hard-code the latest threshold for older polls or promise absolute anonymity. Small polls and identifying answer text can expose a participant even without a stored identity-to-answer link.
- **Local vs. production:** Use synthetic accounts and disposable local data in tests and demos. Never copy live eligibility lists, answers, OAuth secrets, certificates with private keys, or production database contents into fixtures, PRs, or logs. Do not enable demo sign-in in production.

## Choose the smallest useful check

| Change | Where to start | Checks to run or extend |
| --- | --- | --- |
| Eligibility import or organiser UX | `apps/portal`, `services/portal-api` | `tests/unit/eligibility-import.test.ts`; add browser coverage if the UI behavior changes |
| Public poll fields or publication rules | `services/respond-api`, `SPEC.md` §§11–13 | `tests/db/public-poll.test.ts`, `tests/db/results.test.ts`; use `tests/demo-browser/results.spec.ts` for the visible result |
| Browser origin, runtime config, or deployment bundle | `packages/config`, `packages/http`, `scripts/check-production-bundles.mjs` | `tests/unit/origins.test.ts`, `tests/browser/origins.spec.ts`, and `npm run build` |
| Credential claim or submission | `packages/protocol`, `services/portal-api`, `services/respond-api` | `tests/db/claim.test.ts`, `tests/db/redeem.test.ts`, and `tests/browser/claim.spec.ts` as applicable; run `npm run test:signer` if signer integration changes |

Use Node 24 and the root npm scripts. For a bug, first reproduce it with a check that would fail without the fix. A focused unit run can use `npm run test:unit -- tests/unit/eligibility-import.test.ts`. Run `npm run typecheck` for TypeScript changes. Use the setup in `README.md` for PostgreSQL, local TLS, and browsers; a `SETUP ERROR` is not a pass. CI runs on synthetic data, so green CI does not prove a live deployment or institutional sign-in works.

## Before handing off a change

1. Explain the user-visible change and which boundary it touches. If it changes the contract, update the relevant `SPEC.md` section and its acceptance evidence.
2. Report what passed, what you didn't run, and any unresolved review concern. For deployment changes, distinguish local checks, CI, and what was actually verified live.
3. Keep the PR scoped, link the issue if there is one, and ask a teammate for a recorded review before merging. For changes to sign-in, publication, data access, or deploy settings, point the reviewer to the exact test or spec section that protects the boundary.
