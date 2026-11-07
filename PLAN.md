# Implementation plan — IITGN Anonymous Feedback & Polls

Status: proposed execution plan for [`SPEC.md`](SPEC.md), v1.0. This is a plan, not evidence that a milestone has passed. The specification controls if the two documents differ; reconcile discrepancies before coding against either one.

## 1. Planning and working rules

### Goal and order

Deliver a **local synthetic-account demo** first, then permit a real-participant release only after the institutional, cryptographic, browser, infrastructure, and operational gates in `SPEC.md` pass. No real participants or claims of verified anonymity before those gates. Do not replace the blind-credential design to meet a deadline.

Work in dependency order. Milestone 0 establishes a working runner; Milestone 1 establishes that the riskiest design can work. Thereafter, each milestone has an observable vertical outcome, a leading acceptance scenario, and an exit gate. Do not implement later milestone behavior merely to make an earlier demo look complete.

### TDD cycle for each behavioral slice

1. Read the relevant `SPEC.md` sections and define the **external behavior** plus one or two important failure cases. Choose the cheapest sufficient test level: unit for pure encodings/validation; real-Postgres integration for constraints, locks, API, and privileges; real-browser E2E for origins, cookies, storage, popup handoff, and CSP.
2. Add a focused test whose expected result is derived independently from the implementation. State what should fail before running it. **Run it and inspect the failure**: missing behavior is valid red; missing tooling, syntax, setup, flakiness, or an unrelated failure is not. Repair the runner before proceeding.
3. Make the smallest coherent production change; rerun the focused test until green. Then run nearby and broader tests appropriate to the blast radius. Refactor while green and rerun affected checks.
4. Record the focused red reason, focused green command/result, broader check result, and any residual risk in the milestone notes or pull request. A passing-first test is investigated, not presented as a red. Preserve pre-existing work; never reset or hide it to manufacture a TDD history.
5. Stop a slice only when the user-facing/API/DB contract and its important failure path are demonstrated. Add tests for plausible regressions, not for a coverage number, private method call order, or static repository layout.

Setup, CI configuration, dependency installation, and external feasibility checks need **direct validation**, not contrived permanent failing tests. A reusable protocol fixture or browser contract can still be developed test-first once its runner is working. Avoid writing all 27 acceptance tests before the relevant implementation slice; keep a traceability map and add focused tests just before each change.

### Planned evidence commands

Establish these root scripts in Milestone 0; they are **planned interfaces, not commands currently available**:

- `npm run typecheck` and `npm run build` for static/build validation.
- `npm run test:unit` for pure protocol, schema, and result-policy behavior.
- `npm run test:signer` for the private native signer running in the pinned `workerd` binary (added in Milestone 1.2).
- `npm run test:db` for API/database behavior against a real disposable PostgreSQL 17 instance.
- `npm run test:browser` for Playwright tests in supported desktop Chromium and Firefox against two local HTTPS hostnames.
- `npm run test` for the local aggregate, with distinct CI jobs for unit, DB, and browser evidence.

Use pinned npm dependencies and a committed lockfile. Select Vitest for TypeScript unit/integration tests and Playwright for browser tests; choose test utilities only when the first real scenario needs them. DB tests must manage isolated fixtures, roll back or recreate state deterministically, and never use production accounts or data. CI and local setup must exercise the same scripts. Test clocks and randomness at their boundaries rather than relying on sleeps or exact wall-clock timing.

### Milestone tracker

Every milestone starts `not started`. Mark `blocked` if a stated prerequisite fails. Mark `complete` only after its exit evidence is recorded; a passing unit test alone does not clear a DB/browser/security gate. Record implementation PR/commit links and exact commands/results when work begins. Nothing in this table implies tests have run.

| Milestone | Status | Prerequisite | Main outcome |
| --- | --- | --- | --- |
| 0. Foundation | complete (with recorded caveats) | `SPEC.md` | Reproducible repository, two-origin test environment, working runners. |
| 1. Feasibility | complete for synthetic development; 1.4 external checks blocked (release prerequisites) | 0 | Proven crypto/native signer and browser-host isolation; documented deployment feasibility. |
| 2. Poll foundation | not started | 1 | Owner-only draft/open/closed lifecycle and public metadata using synthetic identities. |
| 3. Anonymous issuance | not started | 2 | One durable blind claim per entitlement and reliable browser handoff. |
| 4. Anonymous redemption | not started | 3 | Exactly one accepted response per credential, with correct concurrent/retry semantics. |
| 5. Results | not started | 4 | Closure-safe, threshold-compliant results and no raw-response organiser access. |
| 6. Production boundaries | not started | 5 | Real OIDC, privacy-safe deployment and operations, retention/recovery gates. |
| 7. Demo and release review | not started | 6 for real release; 5 for synthetic demo | Complete walkthrough and independently checked acceptance evidence. |

## 2. Milestone 0 — Foundation (detailed)

**Purpose:** Establish tools that let subsequent tests fail for missing behavior, not for missing infrastructure. Initial inventory: this directory contains `SPEC.md` and this plan only; it is not yet a Git repository. Node 24, npm, and Docker are present. `psql`, `mkcert`, and `workerd` were not found on the current PATH. This is an inventory, not a successful dependency/setup check.

### Work packages

**0.1 Preserve and version the starting point**

- Confirm current files and status. Initialize Git without removing or rewriting `SPEC.md` or this plan; add `.gitignore` for secrets, build output, test artifacts, and local certificates. Commit specification and plan as the baseline.
- Create an npm workspace with the fewest packages necessary for two browser entry points, two API processes, and a private signer proof. Introduce shared protocol/schema code only when the first consuming slice needs it. Pin Node 24 in the repository and commit the npm lockfile.
- Direct validation: clean checkout/install, `npm run typecheck`, and `npm run build` succeed without secrets or production credentials.

**0.1 observed evidence:** Baseline documents committed as `5bb9a47`, scaffold committed as `1fe436f`. In a fresh temporary clone, `npm ci --no-audit --no-fund`, `npm run typecheck`, and `npm run build` all passed without credentials. Both empty Fastify app factories constructed and closed without starting a listener. The lockfile pins the current skeleton; there are no behavior tests, database, HTTPS origins, private signer, or running APIs yet. Foundation milestone remains **in progress**.

**0.2 Make local infrastructure reproducible**

- Supply a disposable PostgreSQL 17 service through Docker Compose with durable-mode settings for integration tests. No in-memory DB substitute for concurrency tests. Separate local test credentials/roles from application credentials.
- Configure `portal.feedback.test` and `respond.feedback.test` to loopback with trusted **HTTPS** certificates and same-origin API paths. Document host mapping and trust steps; no same-host/different-port shortcut. Keep local secrets and certificates untracked.
- Direct validation: both hostnames resolve and serve independently over HTTPS; DB connectivity, migration up/down, test DB reset, and clean shutdown work. A same-host/different-port misconfiguration is rejected.

**0.3 Prove the runner itself works**

- Add the Vitest and Playwright runners and root scripts listed above; include one tiny runner smoke check per runner, then replace setup-only smoke checks with meaningful contract tests once available. Configure CI jobs to install, start disposable services, run, and tear down.
- Direct validation: a deliberately failing temporary check is reported as failure, restored to green without erasing existing work; targeted and aggregate commands propagate nonzero exit status. Missing database/browser prerequisites are clear setup errors, never counted as TDD red.

**0.2/0.3 observed evidence** (commit `946144f`, branch `foundation-feasibility`):

- Origin preflight (`packages/config/src/origins.ts`, `tests/unit/origins.test.ts`): focused red was 11 assertion failures, "expected [Function] to throw", against a pass-through stub. Two cases passed first: the accepting case (by construction) and the empty value (`new URL("")` already throws). Green: 13/13. Vite and Playwright both read origins through the preflight. With `FEEDBACK_RESPOND_ORIGIN=https://portal.feedback.test:4174`, both `npm run test:browser` and `npm run dev -w @iitgn-feedback/respond` exit 1 with "must use distinct hostnames" before any server starts.
- HTTPS: Playwright's `tls` setup project uses Node `https` with `ca: .certs/dev-ca.crt` and default hostname verification. Each hostname returned 200 with distinct app HTML; `unlisted.feedback.test` was rejected for a certificate-name mismatch. The Chromium/Firefox cookie test (portal `__Host-` cookie absent from response-host requests; Web Crypto, IndexedDB, and Web Locks present) depends on that project.
- DB: `tests/db/global-setup.ts` creates `feedback_test_<time>_<rand>` per run and drops it `WITH (FORCE)`. After runs, `pg_database` held 0 such databases. The test asserts PG 17.x, `fsync=on`, `synchronous_commit=on`, and zero user tables. An unreachable port and a non-loopback URL each stop with `SETUP ERROR`. `scripts/check-local-db.sh` printed its PASS line.
- Fresh clone of `da5276b` into a scratch directory: `npm ci`, `scripts/create-dev-certs.sh`, `npm run typecheck`, `npm run build`, and `npm run test` all exited 0. Temporary failing tests in each suite made both the targeted script and `npm run test` exit 1. After deleting them, `npm run test` exited 0 and `git status` was clean.
- Tool versions observed: Node 24.19.0, npm 12.2.0, Vitest 5.1.0, Playwright 1.65.0 (Chromium build 1254, Firefox build 1572), and `postgres:17@sha256:ff87…b4f`.

**Caveats carried forward:**

1. `.github/workflows/ci.yml` is **written but never executed**: there is no git remote.
2. Browsers ignore certificate errors for the local CA. Strict trust is proven only by the Node-side `tls` check.
3. `/etc/hosts` is not modified (sudo). Automated tests map hostnames inside the browser; interactive steps are in `README.md`.
4. Drizzle migration up/down and separate application DB roles are deferred to the first schema slice in Milestone 2. The only role today is the Compose superuser, and tests use it only to create and drop the disposable database.

### Exit gate

A fresh local checkout can install, build, run unit/DB/browser runners against two HTTPS hostnames, and reset test data. Document the exact observed commands and any browser/environment caveats. **Do not** claim a privacy or credential guarantee from runner smoke tests.

## 3. Milestone 1 — Feasibility and boundary proof (detailed)

**Purpose:** Remove the principal architectural risks before building poll features. It is acceptable for an external institutional OAuth or hosting check to remain a **real-participant release blocker** while synthetic local development continues; it is not acceptable for the blind-signature/native-signer or two-origin protocol to remain hypothetical before Milestone 2.

### Work packages and checks

**1.1 Exact byte-level protocol**

- First behavior test: independently compute the application message and nullifier in `SPEC.md` §7 and assert the published fixtures/lengths. Expected initial red: the protocol encoding function does not exist. Do not compute expected bytes by calling the function under test.
- Implement canonical UUID/base64url parsing, version/tag/poll/key checks, prepared-message handling, and nullifier computation. Add wrong-version/length/encoding cases. Run focused unit tests, then `test:unit`, typecheck, and build.

**1.1 observed evidence** (commit `da5276b`): the previous session's fixture and grammar code existed without a recorded red; the earliest red observed in this session was the base64url case ("expected undefined to be '_w'"). A first rewrite let base64url rejection cases pass vacuously (calling a missing export throws `TypeError`). Every rejection now asserts its specific error message, and the honest red was 9 failures (`encodeBase64Url is not a function`, missing-message mismatches). Green: 29/29 in `tests/unit/credential.test.ts`. Expected values come from SPEC.md §7 constants and Node `Buffer` base64url, never from the code under test. The 20 grammar/encoding tests that passed first were mutation-checked: removing the length, tag, version, poll, or key-version check; relaxing UUID case or version; dropping the nullifier version byte; skipping the canonical re-encode; or skipping the secret-length check each made at least one test fail. `npm run test:unit` (42), `typecheck`, and `build` passed. Still open for 1.2: running the same fixture in real browsers.

**1.2 Browser/client and native signer spike**

- Pin `@cloudflare/blindrsa-ts@0.4.6`; stand up the isolated native `RSA-RAW` signer with the runtime/option specified by `SPEC.md`. Do not fall back to the package's JavaScript private-signing path or a custom RSA implementation.
- Use RFC 9474 suite vectors as independent assertions. Exercise prepare → blind → private native sign → finalize → verify in Node and in supported browsers, including a persisted 111-byte prepared message. Check signer input/range rejection, private-operation protections/fault check, key creation/storage/restart, and two independent poll keys. Avoid recording key material or blind requests in output.
- Capture the selected `workerd` release/container digest, real native option spelling, library pin/integrity, test commands, browser versions, and a short review of the actual private operation. A package README or a green mock test is not proof of native signing.

**1.2 observed evidence** (commit `7e74f15`):

*Pins:*
- `@cloudflare/blindrsa-ts@0.4.6`: `sha512-n+CAo1hM78qkiouXB0Io1pPVBFKIaJqU7FqdCDNtBAB7q2bBpQOifv7Om3Jln/nx+IhjQAjlDjp8la3e9Yg9Bw==`.
- `workerd@1.20261023.1` (npm `sha512-NeofJFya…zRrsg==`, about two weeks old when pinned) with `@cloudflare/workerd-linux-64@1.20261023.1` (`sha512-VHQ6jKFS…L1KBnw==`). The binary reports `workerd 2026-10-23`.
- workerd pins BoringSSL `0.20261020.0` (archive sha256 `218355340f67…d836f4`). `rolldown@1.2.16` bundles the worker.
- **No container image or digest is selected yet**; this is a release blocker.
- npm 12 blocked workerd's postinstall script; it isn't needed.

*Native path, verified from source at those tags:*
- The real option is `supportsRSARAW: true` (`BlindRSAPlatformParams`). With it, `blindSign` calls `crypto.subtle.sign({name: "RSA-RAW"})`. The library's own `m == RSAVP1(s)` fault check runs **only on its JavaScript path**, so the signer adds an independent RSAVP1 check (`services/signer/src/fault-check.ts`).
- workerd `api/crypto/rsa.c++`: RSA-RAW imports only private keys and runs `validateRsaParams`. `Rsa::sign` accepts inputs no larger than the modulus, checks `m < n` only at equal length, and **does not reject `m = 0`**. It calls BoringSSL `RSA_decrypt(…, RSA_NO_PADDING)`.
- BoringSSL `rsa_default_decrypt` requires the input to be exactly modulus-size. `rsa_default_private_transform` rejects `m ≥ n`, refuses keys without `e`, uses constant-time CRT/`BN_mod_exp_mont_consttime`, and in all cases verifies `result^e == input` before returning.
- **No RSA blinding code exists in this BoringSSL revision**; side-channel resistance rests on the constant-time implementation. Treat this as a review finding needing security sign-off before release, not as a pass.
- A PKCS#8 with a corrupted `dP` was rejected at import (observed `400 invalid_request`).

*Signer contract:* `POST /blind-sign` and `GET /health`, both behind a service bearer credential compared in constant time through SHA-256 digests. The service:
- serves loopback only (`127.0.0.1` listener observed), with `globalOutbound` set to a network allowing nothing;
- accepts only an exact canonical JSON body with canonical base64url, a 16 KiB cap enforced on both `Content-Length` and streamed bytes, exactly 384 bytes, `0 < m < n`, and a 3072-bit, e=65537 key;
- returns fixed generic error bodies, never logs, and fails closed if the credential binding is missing or shorter than 32 characters.

*Tests:*
- `tests/unit/blind.test.ts` (16): red was 15 "not implemented" failures. The one pass checks only the fixture against OpenSSL. Green: 16/16.
- `tests/signer/signer.test.ts` (28, real workerd): the signer was **written spike-first, so no red is claimed**. Mutation check: removing the zero check, upper range check, exponent policy, canonical-JSON check, or auth, or switching to the JavaScript signing path, each failed tests. The streamed-body limit initially survived (a `Content-Length` check fired first), so a chunked-body test was added and now kills it. Removing the 3072 check survives, as an equivalent mutant (decoding `n` as exactly 384 bytes already enforces it). Detailed-500-error and no-fault-check mutants are unreachable without fault injection. The fault check is therefore extracted and covered by `tests/unit/signer-fault-check.test.ts` (4; a no-op mutant fails 2).
- RFC 9474 A.1 was extracted mechanically from the RFC text (sha256 `e6fd49e5…8818b7`) with its algebraic relations checked. It passes in Node (finalize/verify, and an OpenSSL raw private operation reproduces `blind_sig`), in workerd's native path (test-only `tests/signer/vector-worker.ts`, never built for deployment, because the vector key is 4096-bit), and in Chromium 158.0.8127.18 and Firefox 159.0.
- `tests/browser/blind-interop.spec.ts`: each browser imports the poll JWK, prepares and blinds, then saves and reads back the prepared message and inverse in IndexedDB. The pinned workerd signer signs. After a reload the browser restores, finalizes, and verifies. Node/OpenSSL independently verifies PSS over the restored 111 bytes, and the random prefix is unchanged.
- Native output equals an OpenSSL raw private operation on the same input. Keys for two polls don't cross-finalize. A 0600 at-rest key file keeps signing for the same published key across a signer restart. The signer log contained none of the ~40 request values sent.
- *Flakes found and fixed:* both cross-key tests failed when the value blinded mod `n_B` was `≥ n_A`, which the signer correctly refuses. They now re-blind and assert the refusal branch. Afterwards, 8/8 and 20/20 repeated runs passed. `npm run test` (unit 63, signer 28, DB 1, browser 8), `typecheck`, and `build` passed.

*Still open:*
- container digest and deployed signer topology;
- service-credential provisioning;
- encrypted key-at-rest store (the test uses only a 0600 file);
- an issuer-side `0 < m < n` check before claim consumption (Milestone 3);
- the harness assumes the `linux-64` workerd binary;
- security review of the no-blinding/constant-time finding.

**1.3 Two-host browser handoff spike**

- With synthetic public data and no real claim endpoint, test fixed-origin `postMessage` readiness/nonce/source checks, popup behavior under browser user gestures, correct `WindowProxy`/COOP behavior, IndexedDB + Web Locks availability, and rejection of forged-origin/source messages. Test portal host-only cookie exclusion from response document/asset/API requests.
- First browser behavior test should fail for an unimplemented handoff/host boundary, not a TLS or browser-install error. Test popup-blocked, direct-visit, reload, and unsupported-browser paths. Discard spike UI that serves no contract; retain useful browser tests and infrastructure.

**1.3 observed evidence** (commit `87d4104`; Chromium 158.0.8127.18, Firefox 159.0):

*Grammar and process:*
- The handshake grammar (`packages/protocol/src/bridge.ts`, `tests/unit/bridge.test.ts`) had a red of 23 failures against a pass-through stub; the 3 accept cases passed by construction. Green: 26/26.
- The response (`apps/respond/src/claim-window.ts`) and portal (`apps/portal/src/claim-bridge.ts`) handshake modules were **written before their browser tests, so no red is claimed**. Hiding them to manufacture one would breach §1. Instead, 13 mutations were run, removing each origin, source, poll, key, nonce, one-init, extra-URL-parameter, and reload check, plus `noopener`. All are now caught. The response-side origin-check mutant initially survived because the only wrong-origin case was also wrong-source; "same window, navigated to another origin" cases were added on both sides.
- All three `postMessage` calls use exact fixed target origins. A `"*"` target isn't detectable by these tests and stays a code-review item.

*Browser tests (`tests/browser/bridge.spec.ts`, `popup-blocker.spec.ts`, `origins.spec.ts`), each in Chromium and Firefox:*
- Click-initiated `/claim-bridge?pollId=` with the opener kept. The URL carries only the poll ID, and both documents served `Cross-Origin-Opener-Policy: unsafe-none`.
- Direct visit gives `direct_visit`; an extra URL parameter gives `invalid_link`; a `null` from `window.open` gives a recoverable `popup_blocked`.
- Missing Web Locks or IndexedDB gives `unsupported` and no claim button. Capabilities are probed by actually opening IndexedDB and requesting a lock.
- The response side rejects:
  - a same-origin window that isn't the opened bridge;
  - the response window posting to itself;
  - the opened bridge window after it navigates to another origin;
  - a wrong poll, wrong type for the state, extra field, JSON string, or more than 2 KiB;
  - a wrong-nonce ack.
- The bridge side rejects a wrong key, wrong poll, bad nonce, a non-opener window, itself, the opener after it navigates to the portal origin, and a second init on the same channel. The init seen by the stub had exactly five fields and a 32-byte nonce.
- Reloading a connected bridge gives `connection_lost`, with no silent reconnect.
- Forcing `COOP: same-origin` on the bridge severs `window.opener` and prevents connection, which shows the header check is load-bearing.
- Response-host document, script, and fetch requests carry no portal `__Host-` cookie. Positive control: the same cookie is sent to the portal.

*Findings:*
- Playwright disables popup blocking by default in both browsers (Chromium `--disable-popup-blocking`; Firefox `playwright.cfg` `dom.disable_open_during_load=false`).
- `page.evaluate` carries simulated user activation, so it's an invalid no-gesture control.
- `chromium-headless-shell` has no popup blocker.
- The `*-popup-blocker` projects therefore use full Chromium (`channel: "chromium"`) without that flag, and Firefox with the pref re-enabled. In both, a load-time `window.open` was blocked while the click-initiated claim window opened and connected.

*Stability and reproducibility:* `--repeat-each=4` over the bridge, popup, and interop specs: 98/98. A fresh clone of `87d4104` passed `npm ci`, certificate creation, `typecheck`, `build`, and `npm run test` (unit 89, signer 28, DB 1, browser 28).

*Deferred to Milestone 3 (not covered here):*
- `claim_request`/`claim_result`/`stored_ack`;
- durable `claim_sent` and read-back;
- the 2-minute same-result resend window;
- concurrent tabs under Web Locks;
- simulated IndexedDB write/read-back failure;
- session expiry and `login_required`;
- closing either window mid-claim;
- handshake timeouts.

The spike poll IDs in `apps/*/src/spike-poll.ts` are synthetic placeholders and must be replaced by the public-poll/claim-context APIs.

**1.4 External feasibility inventory (direct checks, not synthetic TDD red)**

- Confirm whether the institution can authorize the OAuth client and whether real signed `email`/`hd` claims meet `SPEC.md` §5. Do not print or commit real tokens or personal data. If accounts/permission are unavailable, mark only the **real-login/release gate** blocked and use synthetic demo identities.
- Confirm that proposed production hosting provides two approved HTTPS hostnames, private signer isolation, durable PostgreSQL/key storage, and configurable edge/CDN/WAF/error logs. Write down what has actually been verified versus assumed. If logs cannot be disabled as required, real deployment is blocked.

**1.4 observed status (2026-11-07): not verified, so blocked for real participants only.**

- *Institutional OAuth:* not attempted. This environment has no OAuth client, client secret, IITGN Google Workspace admin contact, or institutional test account. Nothing is known about whether IITGN can authorize the client or what the signed `email`/`hd` claims contain. The **real-login gate is blocked**; synthetic demo identities proceed in Milestone 2.
- *Hosting:* no provider or topology has been chosen. None of the following has been verified: two approved HTTPS hostnames, private signer isolation, durable PostgreSQL, an encrypted key store, or configurable/disableable edge/CDN/WAF/error logs. **Real deployment is blocked.**
- *Verified so far, on loopback only:* two-hostname cookie/origin isolation, the native signer, and browser interoperation. None of it says anything about a production deployment.

### Stop/go decision

- **Go to Milestone 2:** native signer + browser verifier pass vectors and an end-to-end blind signature round trip; two-host bridge and cookie boundary are demonstrated; test environment is reproducible. Real IITGN login/hosting may remain explicitly marked as release prerequisites.
- **Stop and revise `SPEC.md` before coding more:** selected crypto/runtime cannot meet the native-signing/interop/security contract, or two approved origin boundaries cannot be made to work. Never silently substitute a shared signing key, ordinary bearer token, IP-tracked rate limit, or same-host ports.

### Exit evidence

Save concise test output, browser network/cookie observations, dependency/runtime pins, signer-path inspection notes, and a release-blocker checklist. No participant data, private keys, credential messages, or authentication tokens in that evidence.

**Stop/go assessment (2026-11-07):** each "Go to Milestone 2" criterion has recorded evidence above:

- the native signer and the browser verifier pass the RFC 9474 vector and an end-to-end blind-signature round trip (1.2);
- the two-host bridge and cookie boundary are demonstrated in Chromium and Firefox (1.3);
- the environment reproduces from a fresh clone (0.2/0.3, 1.3).

None of the "stop and revise SPEC.md" conditions occurred. **Recommendation: go to Milestone 2 for synthetic development**, with these items explicitly open.

**Release-blocker checklist** (each item must have evidence before real participants):

1. Institutional OAuth client authorization, and observed signed IITGN `email`/`hd` claims meeting §5 (1.4).
2. Hosting with two approved HTTPS hostnames, durable PostgreSQL, an encrypted private-key store, private signer network isolation, and edge/CDN/WAF/error logging configured per §15 (1.4).
3. A signer container image and digest selected and pinned. Today only the npm `workerd` binary is pinned (1.2).
4. Security review of the native private operation: BoringSSL `0.20261020.0` uses constant-time CRT with a fault check but **no RSA blinding** (1.2).
5. Signer service-credential provisioning and rotation, plus an issuer-side `0 < m < n` check before claim consumption (Milestone 3).
6. CI executed on a real remote. `.github/workflows/ci.yml` has never run (0.3).
7. Production CSP/header set and HSTS from deployment (Milestone 6). Dev servers set only COOP, XFO, Referrer-Policy, and nosniff (1.3).
8. Synthetic spike poll IDs removed from both apps (Milestones 2–3).
9. A test harness for non-`linux-64` platforms, if they're needed (1.2).

## 4. Later milestones — scoped outcomes and exit gates

These are commitments, **not** a line-by-line task backlog yet. Before each milestone, turn its next observable outcome into a small sequence of red/green/refactor slices and update the tracker.

### Milestone 2 — Poll foundation

- Build synthetic demo authentication with stable account subjects in a separate development-only artifact. Implement organiser provisioning, owner-only routes, draft creation/update/preview/import, validations, per-poll key provisioning, poll listing/public DTOs, revision checks, opening freeze, deadline/manual closure, and DB role boundaries that these routes need.
- Leading tests: invalid/duplicate eligibility is rejected without partial import; organiser A cannot access organiser B's poll; draft is not public; a frozen open poll cannot be edited; an expired poll closes without waiting for the scheduler. Use real DB/API integration for transaction and permission behavior; unit tests for pure input normalization.
- Exit: an organiser can create, edit, preview, open, and close a poll through documented APIs; public metadata reveals neither allowlist nor claim/response counts; draft/open/close races and forbidden role reads are tested. No claim or response is fabricated for the demo.

### Milestone 3 — Anonymous issuance

- Add the response-origin credential state machine and portal bridge from Milestone 1, authenticated claim API, stable-account/email-entry uniqueness, durable claim-before-sign ordering, private signer access, error/uncertainty UX, and per-poll key binding.
- Leading tests: one account or eligibility entry cannot obtain two signatures under concurrent claims; a blinded message for B signed through A does not verify with B's public key (full redemption check follows in Milestone 4); crash before/after commit never releases a signature early; losing the bridge result never triggers a second claim.
- Exit: with synthetic identities, one eligible account can obtain and locally verify one poll-bound credential; unsupported storage/browser and uncertain issuance fail closed. Claim rows contain no credential material.

### Milestone 4 — Anonymous redemption

- Add frozen-schema answer validation/canonicalization, public verifier, nullifier insertion with real DB locking/uniqueness, idempotent identical retry, changed-answer conflict, closure/advisory-lock ordering, and browser pending/cleanup behavior.
- Leading tests: one valid credential creates exactly one row despite parallel submissions; an identical retry after lost acknowledgment and normal closure confirms acceptance; changed answers cannot replace it; close/deadline versus in-flight requests cannot admit a late first response.
- Exit: the minimal synthetic-account **vertical slice** works across both hostnames, including duplicate, invalid, expired, and retry paths. Response schema and logs contain no respondent-level identity linkage.

### Milestone 5 — Gated results

- Add serialized final closure and snapshot creation, organiser-only access, poll/question thresholds, fixed result DTOs, structured aggregation, independent persistent free-text shuffling, safe text rendering, and warnings. No response-row export or live results.
- Leading tests: four responses permanently withhold results; five responses do not publish a question with four answers; ready results contain only allowed aggregates/texts; result publication waits for admitted in-flight commits.
- Exit: owner sees results only after closure and thresholds; the actual JSON cannot reconstruct cross-question response profiles from row ordering/IDs; malicious content remains inert in browser tests.

### Milestone 6 — Production boundaries and operations

- Implement/test real Google OIDC (only with authorized institutional accounts), session/CSRF flow, runtime DB privileges, request bounds, strict deployment headers, logging controls, scheduled retention, key destruction, purge/withdrawal journal, backup restore fail-closed policy, and operator withdrawal. Do not bypass external access/hosting requirements for a passing test.
- Leading tests: right email suffix without signed institutional `hd` fails; all organiser mutations require correct identity/CSRF; forbidden roles cannot read raw response/identity tables; restored open polls cannot resume; withdrawn/expired data cannot reappear from backup; error paths do not log participant data.
- Exit: security/operations acceptance tests pass with production-like infrastructure **and** the real-participant release checklist has documented evidence or explicitly remains blocked. Synthetic demo can still ship separately if external approvals are unavailable.

### Milestone 7 — Walkthrough and release review

- Run the ten-eligible/five-response demo and four-response withheld demo from `SPEC.md` §17; verify in both supported browsers and review all 27 scenario records, performance limits, recovery drills, network/log captures, and actual API payloads.
- Exit for **synthetic demo:** reproducible clean-run walkthrough and acceptance evidence for local behavior, with real-OAuth/hosting gaps labelled clearly.
- Exit for **real participants:** all `SPEC.md` §18 release gates independently passed; no open blocker hidden by a demo mock or a green unit test.

## 5. Acceptance-scenario ownership

The numbers below refer to `SPEC.md` §17. A row assigns the **primary milestone that must demonstrate the scenario**, not permission to defer foundational protections; where useful, earlier work is noted. Record observed test names/commands alongside these entries as they are implemented.

| Scenario | Primary milestone | Required evidence |
| --- | --- | --- |
| 1 | 6 | Real OIDC signature/claim/nonce/domain failures and successful institutional login. |
| 2 | 3 | Stable subject and both account/email-entry claim constraints; session behavior from 6. |
| 3 | 2 | Organiser ownership and role checks, revisited under production OIDC in 6. |
| 4 | 6 | Real session/CSRF/origin tests and production demo-auth exclusion. |
| 5 | 1 | RFC suite/encoding vectors, native signing, browser/server interoperation. |
| 6 | 4 | Distinct keys and attempted hidden cross-poll issuance/redeem; key-isolation proof begins in 3. |
| 7 | 4 | Malformed credentials/messages/answers cannot create a response. |
| 8 | 3 | Concurrent claim and crash-window database/signer tests. |
| 9 | 3 | Draft/closed/expired/withdrawn issuance rejection and key restart behavior. |
| 10 | 4 | Parallel identical/different-answer redemption and nullifier uniqueness. |
| 11 | 4 | Server answer validation, normalization, and idempotency. |
| 12 | 4 | Lost-acknowledgment and deadline-crossing retry semantics. |
| 13 | 4 | Real DB claim/submit/close race; results finalization completed and rechecked in 5. |
| 14 | 2 | Draft revision/freeze and open/edit race with DB roles. |
| 15 | 1 | Real-browser cookie and hostname isolation captures. |
| 16 | 3 | Full bridge/store failure modes; basic handoff proof begins in 1. |
| 17 | 4 | Browser prepared/usable/pending/terminal cleanup and no-secret transport checks. |
| 18 | 5 | Malicious organiser/answer content, CSP, opener, and rendering checks; safe rendering starts in 2. |
| 19 | 6 | Persistence and real ingress/app/native signer/error log review; enforce safe defaults from 1 onward. |
| 20 | 6 | Full runtime role/function privilege checks; establish foundational DB roles in 2. |
| 21 | 5 | Poll/question threshold boundaries and withheld DTOs. |
| 22 | 5 | Aggregation, skipped answers, stable independent text order, actual JSON shape. |
| 23 | 5 | Immutable policy, withheld permanence, export/filter denial, withdrawal snapshot gating; operations in 6. |
| 24 | 6 | Overload, limiter privacy, and timeouts. |
| 25 | 6 | Retention, browser expiry, deletion, and backup schedule. |
| 26 | 6 | Backup rollback/withdrawal journal/key-loss drills. |
| 27 | 7 | Full synthetic walkthrough and below-threshold example. |

## 6. First execution decision

Begin with **Milestone 0.1**: preserve the two documents, initialize version control, and establish the minimal npm workspace. Do not generate a full application or add an extensive test suite before the runner and Phase 0 feasibility checks work. After Milestone 0 passes, the first behavior-driven red should be the independent credential-byte fixture in Milestone 1.1; the next major stop/go decision is the native blind-signing/browser interoperability proof.
