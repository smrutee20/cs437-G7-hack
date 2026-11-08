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
| 2. Poll foundation | complete for synthetic development; production auth/operations deferred to 6 | 1 | Owner-only draft/open/closed lifecycle and public metadata using synthetic identities. |
| 3. Anonymous issuance | complete for synthetic development; signer provisioning and request budget deferred to 6 | 2 | One durable blind claim per entitlement and reliable browser handoff. |
| 4. Anonymous redemption | complete for synthetic development; log review and draft persistence deferred | 3 | Exactly one accepted response per credential, with correct concurrent/retry semantics. |
| 5. Results | complete for synthetic development; results-withdrawal journal and operations deferred to 6 | 4 | Closure-safe, threshold-compliant results and no raw-response organiser access. |
| 6. Production boundaries | in progress (synthetic/local evidence only) | 5 | Real OIDC, privacy-safe deployment and operations, retention/recovery gates. |
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
4. At the Milestone 0 exit, Drizzle migration up/down and separate application DB roles were deferred. Milestone 2 now has a partial Drizzle migration with a public-only non-login role and a disposable-test down helper; issuer/admin roles now have partial grants; redemption role, credential provisioning, and production role-login provisioning remain outstanding. The Compose superuser is used for disposable DB creation/migration/test fixture setup, not by a running API.

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
5. Signer service-credential provisioning and rotation (Milestone 3/6). The issuer-side `0 < m < n` check before claim consumption now exists and is tested (Milestone 3, slice 1).
6. CI executed on a real remote. `.github/workflows/ci.yml` has never run (0.3).
7. Production CSP/header set and HSTS from deployment (Milestone 6). Dev servers set only COOP, XFO, Referrer-Policy, and nosniff (1.3).
8. ~~Synthetic spike poll IDs removed from both apps.~~ Done in Milestone 3 slice 3: both apps and all browser tests use the public-poll/claim-context APIs (stubbed in `tests/browser`, real in `tests/demo-browser`).
9. A test harness for non-`linux-64` platforms, if they're needed (1.2).

## 4. Later milestones — scoped outcomes and exit gates

These are commitments, **not** a line-by-line task backlog yet. Before each milestone, turn its next observable outcome into a small sequence of red/green/refactor slices and update the tracker.

### Milestone 2 — Poll foundation

**First slice (eligibility array validation, 2026-11-07):** `services/portal-api/src/eligibility.ts` validates server-side `DraftInput.eligibilityEmails` as 10–1,000 distinct normalized institutional ASCII addresses; duplicate entries collapse, invalid rows fail as a group with 1-based row numbers but no email contents. Focused red: 15 failures against a throwing stub; then two independently observed failures (Unicode Kelvin sign case-folding to ASCII, and a sparse array bypass). Focused green: `npm run test:unit -- tests/unit/eligibility.test.ts` (16/16); broader `npm run test:unit` (105/105), `npm run typecheck`, and `npm run build` passed. **Not yet connected** to the API or database; there is no server-side CSV parser, poll schema, organiser authentication, or role boundary. The Milestone 2 exit gate is not met. Next slice: input normalization for draft questions and/or the real-Postgres schema and owner-only creation route, with the first DB behavior test before implementation. Do not claim all-or-nothing *database import* from this pure-array test.

**Second slice (partial persistence and key foundation, 2026-11-07):** Drizzle SQL migration `services/portal-api/drizzle/0000_poll_foundation.sql` and migration runner establish identity/poll/key/eligibility/claim tables, public-only view and a non-login public response role. DB triggers freeze poll fields, eligibility and keys after opening; the view masks drafts and reflects deadline-expired closure. The first DB test failed as expected with `migration not implemented`; a later key mutation assertion failed until the freeze trigger was added; an expired-open view assertion failed (`open` instead of `closed`) until the effective-status view changed. The intermediate `opened_time` failure was a **bad test fixture**, repaired before claiming green. `npm run test:db -- tests/db/foundation.test.ts` passed (2/2); `npm run test:db` passed (3/3). A further freeze check exposed mutable open timestamps; it was red against the first migration and green after the trigger change. The local-only destructive down helper rejects non-disposable URLs; no intentional unsafe red was run for that guard. Per-poll Node/OpenSSL 3072-bit key generation and AES-256-GCM encrypted 0600 file storage use a caller-supplied independent encryption key. Key test red was `key provisioning not implemented`; focused green 1/1, unit suite 106/106, typecheck/build passed. `npm audit --audit-level=moderate` found zero vulnerabilities after removing an unused vulnerable `drizzle-kit` dependency. `npm run typecheck`, `npm run build`, and `npm run test` passed after the rollback guard and timestamp freeze change (unit 106, signer 28, DB 3, browser 28). No private key or participant data was used in recorded evidence.

**Important gaps at second slice (some addressed in the third slice below):** migration is not a complete production schema/role design: no sessions, response table/function, key lifecycle/retention, or fully scoped production runtime roles; a test-only row contains dummy public-key material; opening/deadline validity and key-to-poll binding are not yet enforced by an API. The file key store has no deployment master-key provisioning/rotation, failure-injection or orphan cleanup yet. No draft/create/edit/open/close API or UI, browser claim state, claim endpoint, or redemption endpoint exists. **Milestone 2 is still in progress; Milestones 3 and 4 remain not started.** For `DraftInput`, interpret “free text explicitly enabled” as the organiser explicitly adding an optional `free_text` question; a new draft starts without one. No undocumented enable field is added. Next: development-only authentication and owner-routed HTTP API/DTOs, open/close concurrency tests, orphan-key recovery and production credential provisioning. Full issuance/redemption follow only after the Milestone 2 gate. Only after the Milestone 2 gate can issuance/redeem follow.

**Third slice (draft/lifecycle service foundation, 2026-11-07):** `services/portal-api/src/draft.ts` validates/normalizes strict `DraftInput` and question IDs/options, UTC deadlines, text/Unicode limits, and eligibility as one payload. Focused unit red was six failures against `draft validation not implemented`; green was 6/6, later 7/7 with a passing-first safety check that row-number errors omit email values. `services/portal-api/drizzle/0000_poll_foundation.sql` now creates partial non-login portal-admin and issuer roles with column-scoped grants and an owner-provisioning-checked `SECURITY DEFINER` create-draft function (fixed search path). The role test red was missing role; the atomic creation test red was a missing function (42883). `services/portal-api/src/create-draft.ts` validates before key provisioning, durably stores the key before the single-statement DB create, and removes the file on definite SQL rejections (not on ambiguous connection/commit errors). The creation test red was `draft creation not implemented`; after repairing a test fixture using the wrong DB role, green was 2/2. `services/portal-api/src/poll-lifecycle.ts` now implements owner-scoped, row-locked draft update/revision checks, open with DB-clock deadline bounds/freeze, and terminal close. Its test red was missing implementations; focused green 2/2. `npm run test:unit` (113/113), `npm run test:db` (5/5 at this point), typecheck and build passed. The migration tests' dummy JWK is for DB privileges only; actual create service tests generate a real encrypted RSA key. No separate synthetic session flow, server-side JSON duplicate-key rejection, full grants, browser UI, deletion/retention, orphan-file sweeper, issuance, or redemption yet. No later milestone may be marked complete from this service-level evidence.

**Fourth slice (partial HTTP metadata and organiser lifecycle, 2026-11-07):** The portal Fastify factory now exposes guarded create/read/update/open/close routes using an injected authentication callback (synthetic sessions exist **only in DB tests**, not a runnable demo login). Both API factories are still without production listeners. The portal's explicit owner DTO contains no private key refs, claim/response counts, or issuer status; the response API uses `feedback_response_public` and `public_polls` for a key-bound public DTO with no identity or eligibility fields. Focused `tests/db/portal-api.test.ts` red: unimplemented routes returned 404; an app-clock mutation then incorrectly made an open poll closed; a text/plain open mutation returned 400 rather than 415; invalid eligibility lacked safe row indices. Each was green after its respective fix (DB-clock effective state, common JSON/Origin/CSRF guard, row-number error). `tests/db/public-poll.test.ts` red: unimplemented open-poll GET returned 404; an overbroad leak assertion then failed on the legitimate `minEligible` policy field and was narrowed to DTO keys and test-email absence. The lifecycle suite's expired-open retry was red (`open` rather than effective `closed`), then green after serialized materialization. Concurrent same-revision update test passed first as regression verification, not a claimed red. `npm run test:db` passed 11/11; `npm run typecheck`, `npm run build`, `npm run test` (unit 113, signer 28, DB 11, browser 28) and `npm audit --audit-level=moderate` (zero vulnerabilities) passed. These integration tests inject Fastify with synthetic callback/session fixtures; no real browser-based app, OAuth or secure session mechanism is claimed. A later CTE rename briefly broke the migration runner with PostgreSQL syntax error (setup failure, not TDD red); after repair `npm run test:db` passed again (11/11).

**Fifth slice (strict JSON, listing, draft deletion, 2026-11-07):** A portal POST with a duplicate `title` first returned 201 (valid behavior red). The strict parser now decodes UTF-8 fatally and rejects duplicate member names, including escaped-equivalent and nested keys, before draft/key creation; focused DB green 1/1, new pure parser tests 2/2 passed first (regression verification). Owner `GET /polls` with `limit=1` first returned 404. It now enforces the 1–50 bound (default 20), `(created_at,id)` descending keyset pagination with six-digit DB microsecond cursor timestamps, an HMAC-protected owner-bound opaque cursor and no question/allowlist fields; focused DB green 1/1. Equal-creation-time tie pagination and cross-owner/tampered cursor rejection also passed. Draft DELETE initially failed with an invalid empty JSON test fixture (400 setup error), then produced the valid missing-route red (404 instead of 204/409). It now uses a restricted security-definer function for atomic draft/key/eligibility removal and a poll-ID-only tombstone; the API removes the encrypted file **after** confirmed DB deletion, never on ambiguous commit. Open/non-owned drafts cannot be deleted; tombstoned IDs cannot be recreated by the create function and the public role cannot read tombstones. Focused DB green 2/2. These changes do not finish backup recovery or live-poll retention. `npm run typecheck`, `npm run build`, `npm run test` (unit 115, signer 28, DB 14, browser 28), and `npm audit --audit-level=moderate` (zero findings) passed after this slice. No test about these slices is evidence for claim/redeem.

**Sixth slice (browser import parser, 2026-11-07):** `apps/portal/src/eligibility-import.ts` parses newline paste and RFC 4180 single-column CSV (quoted fields, escaped quotes, optional email header), rejects extra columns/malformed/blank rows all-or-nothing, and leaves semantic institutional email checks to the independent server validator. Red was 3 failures against `import parsing not implemented`; focused green 3/3, `npm run test:unit` 118/118, typecheck and build passed. The parser is **not yet wired to an organiser UI** and does not prove a browser workflow.

**Seventh slice (open/edit race and old orphan-key cleanup, 2026-11-07):** A real-Postgres two-client concurrent open/update test passed first as regression verification: exactly one action succeeds; frozen open content never includes the racing edit. `feedback_key_janitor` is a non-login background role with only `SELECT(key_id)` on signing keys. Its DB test was red for the missing role, then red for `orphan sweep not implemented`; focused green 1/1 and DB suite 16/16. `services/portal-api/src/orphan-keys.ts` uses a 24h quarantine beyond the 10s create budget, checks 0700 directory/0600 file ownership, queries only key IDs, and fsyncs after removal; it keeps live and young keys. **This is a callable background primitive, not a scheduled job or a recovery drill.** It does not delete keys for closed polls and does not address stale database/backup state.

**Historical gap at this slice (superseded by later slices below):** no standalone demo-auth artifact/session/login, client-side synthetic preview or organiser UI, or fully provisioned runtime DB logins. No live claim/response race exists to test until Milestones 3–4. Background orphan job scheduling, closed-poll key destruction, retention/rotation and restore drills remain operational work. The portal API factory has no deployed HTTPS listener and its authentication callback must not be treated as a production auth implementation. Milestones 3–4 stay not started until this gate closes.

**Eighth slice (synthetic login and public HTTP smoke, 2026-11-08):** `services/portal-api/dev/demo.mjs` is an explicitly gated, loopback-only synthetic launcher outside production builds. It seeds stable test subjects, rotates local runtime-login passwords, uses separate portal/public DB pools, an in-memory host-only `Secure` session and CSRF, and runs two API listeners plus a portal-only demo login listener behind the two Vite HTTPS proxies. Local HTTPS smoke used synthetic organiser login to create/open a poll and read its public metadata. This does not implement institutional OIDC or establish a production session service.

**Ninth slice (browser organiser and expiry, 2026-11-08):** Organiser UI now covers sign-in, owner list/select/edit, all-or-nothing paste/CSV import, synthetic-only preview (zero API writes), create/open/close with irreversible warnings, and explicit deadline display. The response app renders non-spike public poll questions and notices as inert text, without pretending claim/submit works. First Playwright test red was missing sign-in UI; focused green: both Chromium and Firefox. Second browser test red showed invalid CSV line reported as row 11 instead of original file line 12; import parser now maps server row indices to physical CSV lines, including multiline quoted fields. Another run found a real selection/edit race: the async poll load could overwrite newly entered text; disabling the form while a selection loads resolved it. Tests cover CSV validation, persisted edit revision, optional free text, public content, malicious-looking title rendered as text, and a cookie-free response origin. `--repeat-each=2` of both demo tests passed 8/8; the independent `npm run test:demo-browser` command passed 4/4. These are local synthetic browser checks, not anonymity evidence.

`0001_deadline_closer.sql` adds a restricted non-login background role as a **forward migration** (not a rewrite of a migration already applied locally). `closeExpiredPolls` is idempotent, uses a conflicting row update and DB clock; the demo launcher invokes it at startup and every 60 seconds with a separate login. DB integration test initially hit a missing role during setup (not TDD red), then the targeted test failed at the unimplemented closer stub; after implementation and fixing a bad test parameter binding, focused green was 1/1. Forbidden identity/key reads and past/future deadline rows are asserted. A concurrent open-versus-close DB regression test passed first and exercises permitted serial outcomes. The orphan-key sweeper is still a callable primitive, not scheduled.

**Milestone 2 exit assessment — complete for synthetic development only (2026-11-08).** Observed `npm run typecheck`, `npm run build`, unit 119/119, native signer 28/28 and real-Postgres 19/19. The first full `npm run test` stopped at browser *setup* because manually started demo Vite processes occupied both ports; after shutting those down, `npm run test:browser` passed 28/28. `FEEDBACK_ENABLE_SYNTHETIC_DEMO=yes-synthetic-only npm run test:demo-browser` passed Chromium/Firefox 4/4, and `npm audit --audit-level=moderate` found zero findings. The synthetic owner can create/edit/preview/open/close; public metadata excludes eligibility and claim/response counts; real DB tests exercise ownership, immutable open polls, open/edit/close races, deadline reads with delayed scheduler and role-denied reads. The milestone gate explicitly forbids fabricating claims/responses: none exist. Production authentication, runtime deployment credentials, retention/key destruction, backup/restore, scheduled orphan cleanup, CSP and real-ingress/log review remain **release-blocking Milestone 6 work**, not hidden by this synthetic milestone. Browser spike poll IDs still need replacement in Milestone 3. Milestone 3/4 exit gates have **not** passed.

- Build synthetic demo authentication with stable account subjects in a separate development-only artifact. Implement organiser provisioning, owner-only routes, draft creation/update/preview/import, validations, per-poll key provisioning, poll listing/public DTOs, revision checks, opening freeze, deadline/manual closure, and DB role boundaries that these routes need.
- Leading tests: invalid/duplicate eligibility is rejected without partial import; organiser A cannot access organiser B's poll; draft is not public; a frozen open poll cannot be edited; an expired poll closes without waiting for the scheduler. Use real DB/API integration for transaction and permission behavior; unit tests for pure input normalization.
- Exit: an organiser can create, edit, preview, open, and close a poll through documented APIs; public metadata reveals neither allowlist nor claim/response counts; draft/open/close races and forbidden role reads are tested. No claim or response is fabricated for the demo.

### Milestone 3 — Anonymous issuance

- Add the response-origin credential state machine and portal bridge from Milestone 1, authenticated claim API, stable-account/email-entry uniqueness, durable claim-before-sign ordering, private signer access, error/uncertainty UX, and per-poll key binding.
- Leading tests: one account or eligibility entry cannot obtain two signatures under concurrent claims; a blinded message for B signed through A does not verify with B's public key (full redemption check follows in Milestone 4); crash before/after commit never releases a signature early; losing the bridge result never triggers a second claim.
- Exit: with synthetic identities, one eligible account can obtain and locally verify one poll-bound credential; unsupported storage/browser and uncertain issuance fail closed. Claim rows contain no credential material.

**Slice 0 (claim context, prior session, recorded 2026-11-08):** found already implemented in the working tree, with no recorded evidence. `GET /polls/:id/claim-context` reads `public_polls` (`0002_claim_context.sql` grants it to `feedback_portal_admin`) and returns the `PublicPoll` DTO. `tests/db/portal-api.test.ts` asserts: draft 404, open 200 with exact DTO keys, no eligibility/claim/private-key fields, and 401 without a session. **No red was observed for it, so none is claimed.**

**Slice 1 (atomic issuance service, 2026-11-08):**

- `0003_claim_issuance.sql` (forward-only) adds `identity.claim_entitlement`. It is `SECURITY DEFINER` with a fixed `search_path` and `lock_timeout = 2s`; `EXECUTE` is granted only to `feedback_issuer`, and the issuer's direct `INSERT` on claims is revoked.
  - It takes `FOR SHARE` on the poll and binds the poll to its key ID.
  - Invalidated returns `poll_withdrawn`; closed or past-deadline (DB clock) returns `poll_closed`.
  - It resolves eligibility only when the session's verified email equals the account's *current* `identity.users.email`. That is an interpretation of §5 "current verified email": a stale session gets `not_eligible`.
  - `INSERT … ON CONFLICT DO NOTHING` lets both unique constraints arbitrate races.
- `services/portal-api/src/claim.ts` order:
  1. Strict framing, poll and key checks, plus canonical 384-byte and `0 < m < n` checks, all before any key load or reservation.
  2. Reserve capacity, then load the key.
  3. `READ COMMITTED` transaction with `SET LOCAL synchronous_commit = on` and 2 s lock/statement timeouts.
  4. Commit, then exactly one sign call.
  5. An independent `publicEncrypt(RSA_NO_PADDING)` public-operation check before releasing the signature.
  6. The private-key buffer is wiped in `finally`.
- Failure mapping:
  - any failure before `COMMIT` is sent → `capacity_unavailable` (definitely not consumed);
  - a `COMMIT` error → `temporarily_unavailable` (no signing, no compensation);
  - a post-commit sign failure or fault → `claim_consumed_no_credential`.
- Tests (`tests/db/claim.test.ts`):
  - Focused red: 7/7 failed with `claim issuance not implemented`; green 7/7.
  - A lock-wait race test was added after green and **passed first**, as regression verification. A holder owns `FOR UPDATE`, then closes, expires, or invalidates the poll, and the waiting claim observes the change.
  - A redundant account pre-check was removed from the function before mutation testing.
  - Mutation (15 mutants): 14 killed. They covered sign-before-commit, no `FOR SHARE`, no locked deadline/withdrawal check, no session-email match, plain `INSERT`, no public-operation check, no key wipe, treating commit failure as definite, no zero or upper range check, no key-ID match, no preflight closure check, and no release on failure. **Survivor:** removing `SET LOCAL synchronous_commit = on`. That mutant is equivalent here because the test DB enforces `on` globally; the line is kept as defense in depth.
- The tests cover:
  - concurrent claims: 8 by one account, and 4+4 by two accounts sharing one email, each produce exactly one signature and one row;
  - the renamed-account and reassigned-address cases;
  - a request blinded for poll B but sent to A not finalizing under B;
  - a lost commit acknowledgement (claim durable, never signed, retry gets `claim_consumed`);
  - a backend killed before commit (not consumed, never signed, retry succeeds);
  - claim rows exactly `{poll_id,user_id,eligibility_id}`.

**Slice 2 (claim route, admission, signer client, 2026-11-08):**

- `capacity.ts` gives 2 concurrent signs, 10 waiting, a 2 s wait, and a health check before consumption. `rate-limit.ts` allows 5 attempts per sliding minute per user ID, in memory, with idle sweep.
  - Unit red: 4 failures, "not implemented".
  - Two failures after implementation were **wrong test expectations**: the sliding window permits five new attempts after expiry, and bob's idle entry is correctly swept. The test was corrected, not the code.
  - A surviving mutant (timed-out waiter left queued) exposed a vacuous synchronous assertion; after the fix it is killed. All 3 capacity mutants are killed. Unit green 4/4.
- `signer-client.ts` accepts only `http://127.0.0.1|[::1]` with no path/query/userinfo and a token ≥ 32 chars. It applies an `AbortSignal` timeout, sends the signer's exact member order, makes no retries, and fails generically with "signer unavailable".
  - Red: 3/3 not implemented, against real workerd. Green: 3/3.
  - An `afterAll` hook timeout came from stalled sockets left open by the test (a harness bug, not a red). Fixed.
  - Mutants killed: any host, no timeout, short token.
- `POST /api/v1/polls/:id/claim` exists only when `createApp` gets `issuer: {acquireClient, signer}`, a separate `feedback_issuer` pool. It applies the route `bodyLimit` 2048, then the existing session/Origin/CSRF/JSON guard, then the per-account limit (`429` + integer `Retry-After`), and maps errors per §13.
  - `tests/db/claim-api.test.ts` red: 404, the route was missing. Green 3/3.
  - Assertions: 201 with `{blindSignature}` only, finalized and verified through `claim-context` keys; repeat 409; 413; 400/404/410/403; unhealthy signer 503 `capacity_unavailable` with nothing consumed; sign failure 503 `claim_consumed_no_credential`; a sixth attempt 429; error bodies echo no email or blinded value.
- Broader checks after slice 2: `npm run typecheck`, `npm run build`, unit 123/123, signer 31/31, DB 30/30, browser 28/28, and `FEEDBACK_ENABLE_SYNTHETIC_DEMO=yes-synthetic-only npm run test:demo-browser` 4/4 all passed. `npm audit` **could not run**: the audit endpoint returned an error (network). This slice added no dependencies.

**Slice 3 (browser credential state and bridge claim, 2026-11-08):**

- **Bridge grammar** (`packages/protocol/src/bridge.ts`): adds `claim_request` (nonce, key ID/version, 384-byte blinded message only), `claim_result` (exactly one of `blindSignature` or a fixed error code), and `stored_ack`.
  - Response-side policy (`apps/respond/src/claim-policy.ts`): only definitive pre-insert errors return to `prepared`; consumed results are terminal; closed/withdrawn/not-found erase; `temporarily_unavailable` keeps `claim_sent`.
  - `tests/unit/bridge-claim.test.ts` red: 3 failures (the accept case and both policy tests). Its 15 rejection cases **passed first, vacuously**, because the old parser rejected unknown types. All 5 grammar mutants were then killed: no key-version check, no blinded-length check, no signature check, any error code, no request key-ID check. Green 18/18.
- **Response origin** (`apps/respond/src/credential-store.ts`, `claim-flow.ts`, `claim-window.ts`, `main.tsx`):
  - Each IndexedDB transition runs under a per-poll Web Lock, uses one `strict`-durability transaction, and is read back before use. Other tabs get a non-secret BroadcastChannel notice and re-read.
  - States: `prepared` → `claim_sent` (written before the request leaves) → `usable` (inverse and blinded request erased), or the markers `claim_consumed`/`claim_uncertain`.
  - The sweep erases unused state when the poll is observed closed, turns a `claim_sent` older than 2 minutes into `claim_uncertain`, and expires markers 7 days after closure. It runs on load, on change, and every 5 s.
  - Preparation is an explicit **Prepare credential** click, so casual visitors generate no secret.
- **Portal bridge** (`apps/portal/src/claim-bridge.ts`, `main.tsx`):
  - It loads claim context and session from the portal API, shows an explicit title/account confirmation, and makes exactly one `POST /claim`.
  - It resends the same in-memory result every second until `stored_ack` or 2 minutes, then erases it, and closes after `stored_ack`.
  - Signed out, it completes the handshake but answers `login_required` with no HTTP attempt. Without a session it cannot check the key ID; nothing is at stake because no attempt is made.
  - Response mapping: a 201 with a malformed body becomes `claim_consumed_no_credential`, a 401 becomes `login_required`, and anything unexpected becomes `temporarily_unavailable`.
- **Decisions:**
  - The response sends `stored_ack` after durably recording *any* outcome, so the bridge can close.
  - A returned signature that fails to verify becomes a terminal `claim_consumed` marker, with no new signing request.
  - Closing the bridge after `claim_request` leaves `claim_sent` and then `claim_uncertain`, even if no HTTP attempt happened. This is SPEC §8's strict reading.
- **Spike IDs removed:** `apps/*/src/spike-poll.ts` are deleted. The `tests/browser` specs now use `tests/browser/fixtures/claim-stubs.ts`, which routes the same-origin APIs and signs claims with an OpenSSL raw private operation in Node. Bridge and popup-blocker end states are now `confirming`/`request_sent`.
- **Browser tests:**
  - `tests/browser/claim.spec.ts` red: every test failed, because the response page had no claim UI for real poll IDs (`getByTestId('capabilities')` not found) and the bridge knew only the spike ID. Green: 9/9 in Chromium on the first implementation run; full browser suite 46/46.
  - **Two weaknesses were found after green and fixed.** The two-tab test compared two reads of the *same* IndexedDB, so an overwriting `prepareIfAbsent` could not fail it; it now drives a stale tab's `prepareCredential` directly. Read-back was untested; a lost-write variant was added.
  - Browser mutation (Chromium, 12 mutants): **all killed**. They covered the request sent without durable `claim_sent`, no read-back, prepare overwriting, usable keeping the inverse, no stranded-claim sweep, no result-nonce check, a bad signature stored as retry, bridge auto-confirm, a second request allowed, no resend, no request key check, and closing before `stored_ack`.
  - `tests/browser/claim-interruptions.spec.ts` (bridge closed mid-claim; 401 at POST) was written after implementation and **passed first**, as regression verification.
- **Real stack:**
  - `services/portal-api/dev/demo.mjs` now starts the pinned workerd signer on loopback 5186 with a per-run token and a `feedback_demo_issuer` login role, and passes `issuer` to the portal app.
  - `tests/demo-browser/claim.spec.ts` was written after implementation, so **no red is claimed**. It passed in Chromium and Firefox. The checks: the stored credential verifies by Node PSS under the poll key, the inverse is erased, and no portal session cookie exists for the response origin. The same account in a fresh browser gets `claim_consumed`; the `ineligible` account stays `prepared` with a not-eligible message.
  - Afterwards there were no orphaned workerd processes or listeners.
- **Scenario 9 restart:** in `tests/db/claim-api.test.ts`, a new app instance signs with the stored key, and a deleted key file returns 503 `capacity_unavailable`, consumes nothing, and writes no replacement key. It **passed first**, as regression verification.
- **Final checks on this tree:** `npm run typecheck`, `npm run build`, and `npm run test` passed (unit 141, signer 31, DB 31, browser 52 across Chromium/Firefox), as did `FEEDBACK_ENABLE_SYNTHETIC_DEMO=yes-synthetic-only npm run test:demo-browser` (6/6). Milestone 2's split commit `d80150c` was separately verified from a fresh clone: `npm ci`, typecheck, build, unit 119, DB 19.

**Milestone 3 exit assessment — complete for synthetic development only (2026-11-08).**

- Every exit item is evidenced. One eligible synthetic account obtains and locally verifies one poll-bound credential through the real issuer and native signer. Unsupported storage and uncertain issuance fail closed. Claim rows hold only `{poll_id,user_id,eligibility_id}`.
- All four leading tests (concurrent uniqueness, cross-poll blinding, the commit crash windows, and a lost bridge result never re-claiming) pass against real PostgreSQL or real browsers.
- **Residual, carried to Milestone 6 or release:**
  - signer service-credential provisioning and rotation, and the container digest;
  - end-to-end enforcement of the 10 s claim request budget (the issuer preflight query has no statement timeout, and the health/sign timeouts are caller-configured);
  - a response tab closed mid-claim is not explicitly tested (the bridge expires its result after 2 minutes);
  - no handshake timeout while waiting for `bridge_ready`/`bridge_ack` (the window-closed poll is the only exit);
  - production OIDC/session for `login_required`.
- The Milestone 4 gate has **not** been attempted. No answers can be submitted.

### Milestone 4 — Anonymous redemption

- Add frozen-schema answer validation/canonicalization, public verifier, nullifier insertion with real DB locking/uniqueness, idempotent identical retry, changed-answer conflict, closure/advisory-lock ordering, and browser pending/cleanup behavior.
- Leading tests: one valid credential creates exactly one row despite parallel submissions; an identical retry after lost acknowledgment and normal closure confirms acceptance; changed answers cannot replace it; close/deadline versus in-flight requests cannot admit a late first response.
- Exit: the minimal synthetic-account **vertical slice** works across both hostnames, including duplicate, invalid, expired, and retry paths. Response schema and logs contain no respondent-level identity linkage.

**Slice 1 (answers and locked redemption, 2026-11-08):**

- **Shared text and answers.** `packages/protocol/src/text.ts` now holds the §7 human-text rule, and the portal's `draft.ts` uses it (the draft unit tests were unchanged and passed). `packages/protocol/src/answers.ts` validates `[{questionId,value}]` against frozen questions. Results are canonical in question order, empty optional text and skipped questions are omitted, and failures carry field paths, never values.
  - `tests/unit/answers.test.ts` red: 23/23 failed on the stub. One expectation was a **test bug**: an all-digit question ID is unchanged by `toUpperCase()`, so a letter-bearing ID now exercises the non-canonical case.
  - Green 23/23. All 7 mutants killed: extra fields, fractional ratings, any UUID option, empty text kept, required not enforced, input order kept, duplicates allowed.
- **Test-runner fix.** The refactor exposed that Vitest resolved `@iitgn-feedback/protocol` to its **stale `dist/` build**, so tests could pass against old code. The unit, DB and signer configs now alias exactly that specifier to `packages/protocol/src/index.ts`. A broader `resolve.conditions` attempt broke `pg` loading (a setup failure, not a red) and was reverted. With `dist/` deleted, unit 164, DB 31 and signer 31 all passed.
- **Redemption.** `0004_redemption.sql` (forward-only) adds `anonymous.responses(poll_id, nullifier 32 bytes, answers jsonb)` with `PRIMARY KEY(poll_id,nullifier)` and no other column. `anonymous.redeem` is `SECURITY DEFINER`, takes the poll `FOR SHARE`, returns withdrawn when invalidated, and then takes `pg_advisory_xact_lock` on the spec's SHA-256-derived key. Next it looks up the existing row (identical → `replayed`, different → `credential_spent`), checks state and deadline immediately before inserting, and rereads the winner on a conflict. The public role gets only `USAGE` on `anonymous` and `EXECUTE`; it has no table grants.
- **Service.** `services/respond-api/src/redeem.ts` order:
  1. Strict framing.
  2. The `public_polls` key.
  3. Key ID/version.
  4. Full signature verification over the 111 bytes, and only then the grammar.
  5. The nullifier.
  6. Canonical answers.
  7. One transaction with 2 s lock/statement timeouts.

  A `COMMIT` failure is retryable (`temporarily_unavailable`) and never reported as success. `tests/db/redeem.test.ts` red: 4 tests failed on the stub, and 2 because the table/function was missing. Green on the first implementation run.
- **What the tests show:**
  - the stored row matches a nullifier computed independently in Node;
  - a reordered, re-spaced identical retry gets 200, before and after closure, while withdrawal gets 410;
  - another preparation of the same secret replays;
  - 6-way identical and different-answer races leave one row;
  - the hidden cross-poll message (signed by A, naming B) is refused at both A and B;
  - framing errors give 400 `invalid_request`; credential errors give `invalid_credential`;
  - a 422 does not spend the credential;
  - a waiter behind closure or withdrawal is refused;
  - a retry past the deadline **waits on the advisory lock** for an uncommitted acceptance and gets 200, with the held lock key matching the Node-derived value;
  - an expired poll still stored as `open` refuses new credentials;
  - a lost commit acknowledgement is retryable and then confirmed;
  - the public role cannot read responses, identities or key references.
- **Mutation:** 12 mutants, 11 killed. Two of the 11 survived the first run and were killed only after test fixes:
  - the locked withdrawal check was unreached behind the service preflight; a lock-wait withdrawal case now kills it;
  - commit-failure-as-success had no test; a lost-ack test now kills it.

  **Remaining survivor:** a plain `INSERT` without `ON CONFLICT`. It is equivalent because the advisory lock serializes same-nullifier attempts, so `ON CONFLICT` stays as defense in depth.
- **Broader checks:** typecheck, build, unit 164/164, DB 38/38.
- **Still open after slice 1:** the public route and the browser submission flow (both addressed below or still open).

**Slice 2 (public submission route and admission, 2026-11-08):**

- **Admission** (`services/respond-api/src/admission.ts`):
  - integer-unit token buckets: public reads 100/s, burst 200; submissions 20/s, burst 40; per poll 5/s, burst 10, with idle per-poll entries forgotten after 10 minutes;
  - a bounded semaphore for signature verification: 4 concurrent, 20 queued, a 2 s wait, and the slot is released even when the task throws.

  Keys are route class or public poll ID only. Unit red: 3 failures, "not implemented". One semaphore expectation was a **test bug**: instantly finishing waiters correctly drain the queue, so the test now uses waiters that hold their slots. Green 3/3.
- **Strict JSON** moved from the portal into `packages/protocol/src/strict-json.ts`, so both APIs reject duplicate members the same way. The `jsonc-parser` dependency moved with it, and the relocated tests passed.
- **`POST /api/v1/polls/:id/responses`.** Header-level checks run in `onRequest`, before any body is read:
  - an exact response `Origin`, or none;
  - no query string;
  - no `Content-Encoding`;
  - JSON only;
  - then the global and per-poll buckets (`429` with an integer `Retry-After`).

  The body limit is 64 KiB. `redeemResponse` runs signature verification inside the semaphore; an overload gives 503 `capacity_unavailable`. Responses are exactly `{status:"accepted"}` with 201 or 200, and never set a cookie.
- **Route tests** (`tests/db/respond-api.test.ts`): red was 404, the route was missing.
  - After implementation, the global-limit case **failed on wall-clock refill** (41 sequential requests took long enough to refill a token), a timing-dependent test. `createApp` now takes an optional admission clock, which the test freezes. Green 4/4.
  - Covered: accept/replay/conflict bodies; no echo of signature or answer text; the cookie ignored; an absent Origin allowed; the portal Origin 403; `text/plain` and gzip 415; a credential in the query 400; a duplicate member 400; over 64 KiB 413; an unknown poll 404; none of these spending the credential; tampered signature 400 `invalid_credential`; missing required answer 422 with `field` but no value; closed poll 410; per-poll and global 429.
- **Route mutation:** 6 mutants, 5 killed (any origin, query allowed, compressed allowed, no per-poll bucket, no global bucket). **Survivor:** removing the verification-semaphore wiring. The semaphore is unit-tested, but driving its limits through HTTP would need a timing-fragile concurrency test; this remains a code-review item.
- **Broader checks:** typecheck, build, unit 167/167, DB 42/42.
- **Still open after slice 2:** the browser submission flow, addressed in slice 3 below.

**Slice 3 (browser submission and cleanup, 2026-11-08):**

- **Store.** `credential-store.ts` adds `submit_pending`: the credential plus the exact canonical answers, with an `uncertain` flag. It also adds the non-secret markers `accepted`, `spent` and `credential_invalid`. The sweep now:
  - keeps `submit_pending` through observed closure and erases it 24 h after the deadline, even if the outcome is unknown;
  - erases unused state when the poll is observed closed;
  - expires markers after 7 days.
- **Flow.** In `submit-flow.ts`, the payload is frozen before the first attempt and every retry resends those exact bytes. Retries are explicit only. Requests use `credentials: "omit"` and no query string. Outcome handling:
  - 201/200 → `accepted` (credential and answers erased);
  - 409 `credential_spent` → `spent`;
  - 410 or 404 → erase;
  - `invalid_credential` → marker;
  - 422 → back to editing;
  - 429 or capacity → back to editing on a first attempt, otherwise keep pending;
  - network or other errors → mark uncertain and keep pending.
- **UI.** `main.tsx` shows an answer form while `usable` (radio groups per question, a textarea for free text), runs the shared canonicalizer only to explain problems early, freezes answers read-only while pending, and shows an explicit **Retry submission** button.
- **Tests.** `tests/browser/submit.spec.ts` red: every test failed, because no answer form existed. Then:
  - one stub bug in the test: `outcomes[index] ?? accepted` turned the intended `null` connection reset into an acceptance;
  - after fixing it, green in Chromium and Firefox.
- **Coverage:**
  - the canonical payload, no cookie, and no query;
  - success leaves only `{closesAt,pollId,state}`;
  - the client-side required check sends nothing, and a server 422 returns to editing without spending;
  - uncertain → frozen → reload → retry hits 429 and stays pending (it does not prove failure) → retry hits 200 → accepted, with three byte-identical payloads;
  - spent erases;
  - closure erases unused state, a first-attempt 410 erases, and a pending submission survives closure but is erased 49 h later (Playwright clock);
  - a respond-origin cookie is never sent.
- **Mutation (10):** **all killed**. They covered accepted keeping the credential, uncertain returning to editing, a rate limit ignoring uncertainty, 422 keeping pending, spent keeping the credential, closed keeping the record, closure erasing pending, pending never expiring, cookies sent, and an automatic retry.
- **Status refresh.** SPEC §8 requires public status to be refreshed before a new claim or submission. A new test failed red: the submission was sent after the poll closed mid-session. Now `stillOpen()` re-reads `/public` before preparing or submitting; observed closure erases the unused credential and sends nothing. Green.
- **Real stack.** `tests/demo-browser/claim.spec.ts` now also answers and submits. Against the demo's real response API, `feedback_response_public` and the local disposable database, it reached `accepted` in Chromium and Firefox. The stored row had exactly `{answers,nullifier,poll_id}` with the canonical answer.
- **Final checks on this tree:** `npm run build`; `npm run test` (unit 167, signer 31, DB 42, browser 66); `FEEDBACK_ENABLE_SYNTHETIC_DEMO=yes-synthetic-only npm run test:demo-browser` 6/6; no orphaned workerd.

**Milestone 4 exit assessment — complete for synthetic development only (2026-11-08).**

- The synthetic vertical slice works across both hostnames in both browsers, with the real issuer, the native signer and the public verifier. The duplicate, invalid, expired and retry paths are tested at the DB, route and browser levels. The response schema has no respondent-level linkage column.
- All four leading tests pass on real PostgreSQL:
  - parallel submissions produce one row;
  - an identical retry after a lost acknowledgement, and after normal closure, confirms;
  - changed answers cannot replace a stored response;
  - close, deadline and in-flight races cannot admit a late first response.
- **Residual, carried forward:**
  - Logs are disabled by construction (`logger: false`, no request logging in the demo launcher), but **no log or ingress capture review** has been done. That is scenario 19, Milestone 6.
  - **Local draft answers are not persisted** in IndexedDB; SPEC §8 lists them in the `prepared`/`usable` states. They live only in page memory. Reconcile the SPEC or implement this before release.
  - The route wiring of the verification semaphore is a mutation survivor (unit-tested only).
  - Plain `INSERT` without `ON CONFLICT` is an equivalent survivor under the advisory lock.
  - After observing closure, the page still shows **Prepare credential** until reload; the refresh check then refuses it.
- Milestone 5 (results) has **not** started. No results endpoint exists.

### Milestone 5 — Gated results

- Add serialized final closure and snapshot creation, organiser-only access, poll/question thresholds, fixed result DTOs, structured aggregation, independent persistent free-text shuffling, safe text rendering, and warnings. No response-row export or live results.
- Leading tests: four responses permanently withhold results; five responses do not publish a question with four answers; ready results contain only allowed aggregates/texts; result publication waits for admitted in-flight commits.
- Exit: owner sees results only after closure and thresholds; the actual JSON cannot reconstruct cross-question response profiles from row ordering/IDs; malicious content remains inert in browser tests.

**Slice 1 (gated publication function and route, 2026-11-08):**

- **Migration.** `0005_results.sql` (forward-only) adds `anonymous.result_snapshots(poll_id, result)`, which can hold only a `ready` DTO. `anonymous.publish_results(poll, owner)` is `SECURITY DEFINER` and runs in this order:
  1. the ownership check;
  2. `FOR UPDATE`, the conflicting closure lock, which waits for admitted claims, redemptions and replays;
  3. materializing deadline closure (`closed_at = closes_at`);
  4. not-closed → `results_not_closed`, invalidated → `poll_withdrawn` (checked *before* any existing snapshot is returned);
  5. an existing snapshot;
  6. fewer than 5 responses → permanent `withheld`;
  7. per-question thresholds and the aggregates.
- **Aggregates.** Percentages use `round(…, 1)` over `answeredCount`, and the mean uses `round(…, 2)`. `round()` here is numeric half away from zero, which is half-up for these non-negative values. Each free-text question is ordered by its own `gen_random_uuid()` (pg_strong_random). The snapshot is inserted once. `feedback_portal_admin` gets only `USAGE` and `EXECUTE`; neither the portal nor the public role can read responses or snapshots.
- **Service.** `services/portal-api/src/results.ts` calls the function; `GET /api/v1/polls/:id/results` maps the outcomes to 200, 409, 404 and 410 and rejects any query string.
- **`tests/db/results.test.ts`:** red was 6/6 "not implemented". On the first implementation run 5/6 passed; the sixth was a **test arithmetic bug** (the ratings summed to 16, not the intended 17). The fix exercises the 2.125 → 2.13 half-up boundary. Covered:
  - not-closed refusal;
  - another organiser and an unknown poll get 404 even after closure;
  - 4 responses are withheld, repeatably;
  - exact single-choice, rating and free-text DTOs, with zero counts, schema order and a four-answer question withheld;
  - 1/16 → 6.3% half-up;
  - the snapshot is immutable and identical to the stored row, contains no nullifier, and shows independent per-question shuffles (statistical across five polls);
  - publication waits for an admitted in-flight response across the deadline and includes it;
  - publication waits on a closed poll's shared lock, and 4 concurrent first reads produce one snapshot;
  - a withdrawn poll gets 410.
- **Mutation (9):** **all killed**. The no-closure-lock mutant initially survived, because the deadline-materializing `UPDATE` itself waits on the lock; the closed-poll lock and concurrent-reads test added for it now kills it.
- **Route test** (`tests/db/results-api.test.ts`): red was 404, the route was missing. One over-broad assertion matched the legitimate `policy.minResponses` field (the same trap Milestone 2 hit) and was narrowed. Green.

**Slice 2 (organiser view and synthetic walkthrough, 2026-11-08):**

- **View.** `apps/portal/src/organiser.tsx` adds **View results** for closed polls and a results region. Every value renders through React text escaping: no HTML, Markdown or links, and free text uses `pre-wrap`. It carries threshold and inference guidance that explicitly says this is not anonymity.
- **Walkthrough.** `tests/demo-browser/results.spec.ts` is SPEC §17 scenario 27 on the real stack. Five synthetic participants each claim and submit:
  - The results show "5 responses", "Morning: 3 (60%)" and "Evening: 2 (40%)".
  - A three-answer free-text question is withheld.
  - On a second poll, hostile strings (`<img onerror>`, `<script>`, a Markdown-style link) render literally, with zero `img`/`script`/`a` elements, no request to the hostile host, and no script effect.
  - A four-response poll shows only the permanent-withholding sentence, with no numeric count.

  Red: the **View results** button was missing. Two later failures were **test assertion bugs**: a digit check matched timestamp digits in the title, and a whitespace-sensitive substring check was ill-posed. Green in Chromium and Firefox.
- **Demo-suite collision, found and fixed.** Running every demo spec in parallel exceeded the real five-claims-per-minute limit on shared synthetic accounts: participants returned to `prepared`. That was the limiter working as specified. The launcher now seeds `student1`–`student40`, and each browser project uses its own account range.
- **Environment finding (not a product defect).** Repeated parallel Firefox runs failed with IndexedDB `UnknownError` because **the root filesystem was full** (95 G of 96 G used, ~127 MB free). Removing this session's scratch clones recovered ~400 MB, and runs at the default worker count pass. Repeat-each stress runs still need more free disk.
- **Final checks:** typecheck, build, `npm run test` (unit 167, signer 31, DB 50, browser 66), and `FEEDBACK_ENABLE_SYNTHETIC_DEMO=yes-synthetic-only npm run test:demo-browser` 8/8.

**Milestone 5 exit assessment — complete for synthetic development only (2026-11-08).**

- The owner sees results only after closure and the thresholds.
- The JSON carries only aggregates and independently shuffled texts; there are no row IDs or nullifiers.
- Malicious content stays inert in both browsers.
- **Residual:**
  - the operator withdrawal command and journal (results are already gated on `invalidated`), plus retention/purge of snapshots: Milestone 6;
  - result-access audit and log review: scenario 19.

### Milestone 6 — Production boundaries and operations

- Implement/test real Google OIDC (only with authorized institutional accounts), session/CSRF flow, runtime DB privileges, request bounds, strict deployment headers, logging controls, scheduled retention, key destruction, purge/withdrawal journal, backup restore fail-closed policy, and operator withdrawal. Do not bypass external access/hosting requirements for a passing test.
- Leading tests: right email suffix without signed institutional `hd` fails; all organiser mutations require correct identity/CSRF; forbidden roles cannot read raw response/identity tables; restored open polls cannot resume; withdrawn/expired data cannot reappear from backup; error paths do not log participant data.
- Exit: security/operations acceptance tests pass with production-like infrastructure **and** the real-participant release checklist has documented evidence or explicitly remains blocked. Synthetic demo can still ship separately if external approvals are unavailable.

**Pre-slice harness fix (2026-11-08):** the baseline `npm run test:db` failed one test, `tests/db/results.test.ts` "shuffles each free-text question independently", with `Test timed out in 5000ms`. It generates five 3072-bit keys; on this machine that overruns Vitest's default. It now has an explicit 60 s budget. That is a harness limit, not a product defect, so no red is claimed.

**Slice 1 (Google OIDC and server-side sessions, 2026-11-08):**

- **Dependency.** `google-auth-library@11.3.1`, pinned exactly in `services/portal-api` (lockfile `sha512-mQS0R2Ev…A7qA==`). 11.3.3 was 5 days old, so the 3-week-old 11.3.1 was chosen. `npm audit --audit-level=moderate`: 0 vulnerabilities.
- **Library review** (`build/src/auth/oauth2client.js`, `verifySignedJwtWithCertsAsync`): it verifies RSA-SHA256 against the keyed certificate, iss, a single-string aud, and iat/exp, but allows **300 s** skew, never inspects the header `alg`, and puts the raw JWT in its error messages. So `oidc.ts` adds an RS256-only header check, 60 s skew, a single-string `aud`, `azp`, a constant-time nonce, `sub`, strict `email_verified === true`, the exact email domain, and the signed `hd`. It discards every library error unread. Token exchange is a direct `fetch` with the PKCE verifier and a 5 s timeout, so no gaxios/google-logging-utils debug path sees the code or tokens.
- **Migration** `0006_sessions.sql` (forward-only):
  - `identity.oauth_transactions` holds hashed state and pre-auth binding, nonce, verifier, an allowlisted return path, and expiry.
  - `identity.sessions` holds the token hash, user, the verified email at sign-in, the CSRF token, and an absolute expiry.
  - `identity.upsert_verified_user` binds `(issuer, sub)` and updates the email, never the organiser flag.
  - The non-login `feedback_auth` role gets only these tables, `SELECT(id, is_organiser)` on users, and the function.
- **Routes.** `GET /auth/login` sets a 10-minute `__Host-preauth` cookie and redirects with `scope=openid email`, S256, and separate 256-bit state/nonce; return paths are only `/` and `/signed-in`. `GET /auth/callback` deletes the transaction first (single use), checks the pre-auth binding, exchanges, verifies, rotates the session, and redirects with `no-store` and `no-referrer` and no body. `POST /auth/logout` goes through the session/Origin/CSRF/JSON guard. Organiser status is read live on every request.
- **Demo.** `dev/demo.mjs` now uses the same DB session store through a `feedback_demo_auth` login. Only its synthetic `/__demo/login` differs, and `/__demo/logout` is removed in favour of the production logout route.
- **Tests** (`tests/db/oidc.test.ts`, a local RS256 test IdP and a stubbed token endpoint; no Google account):
  - Red: 4/4 failed (500 from the stub store; no login route).
  - Green: 4/4.
  - 18 ID-token failures are refused: issuer, audience, multiple audiences, foreign `azp`, expiry, future `iat`, nonce, missing/wrong/suffix `hd`, `email_verified` false and `"true"`, gmail and subdomain email, empty `sub`, a foreign signing key, an HS256 header, and an unknown `kid`.
  - Also refused: reused state, a missing or forged pre-auth cookie (which also burns the state), an expired transaction, a provider `error`, an unexpected callback parameter, and 7 unsafe return paths.
  - Positive cases: a stable `(issuer, sub)` across an email change, normalised issuer, session rotation, logout CSRF/Origin, the absolute expiry, and cookie attributes.
  - Mutation, 9 mutants, **all killed**: no `hd`, no nonce, no pre-auth binding, the library's 300 s skew, truthy `email_verified`, no `azp`, reusable state, email suffix only, no expiry.
- **Harness fix.** The test-only `rollbackFoundation` dropped `identity.users` explicitly. The new sessions FK blocked that and left the shared test DB dirty, so later files failed at migration (a setup failure, not a red). It now drops sessions/transactions first.
- **Broader checks:** typecheck, build, unit 167/167, DB 54/54, and `test:demo-browser` 8/8.
- **Not established:** a real Google client, institutional `hd`, or real tokens (release blocker 1). No production listener exists yet.

**Slice 2 (retention, key destruction, withdrawal journal and recovery, 2026-11-08):**

- **Migration** `0007_operations.sql` (forward-only):
  - `signing_keys.lifecycle` runs `active → destroy_pending → destroyed`, and the reference is nulled at `destroyed`. The key freeze trigger permits only that forward change after opening.
  - `polls.invalidation_reason`; withdrawal and its reason are permanent in every state.
  - Access boundaries applied at read time, independently of deletion: `public_polls`, owner GET/list, `anonymous.redeem` and `anonymous.publish_results` treat polls 90 days past effective closure as not found, and owner DTOs show eligibility as `purged` after 7 days.
  - Protected rows (claims, responses, snapshots, frozen eligibility/keys, retained polls) can be deleted only in table-owner context (reviewed `SECURITY DEFINER` functions or offline recovery), **never while the poll is open, even by the owner**. `TRUNCATE` is refused on claims, responses and snapshots, and snapshots are immutable.
  - Retention functions for the non-login `feedback_retention` role: `retention_sweep` (closure materialisation, 7-day claims/eligibility, key marking, auth state, non-organiser users with nothing retained, 1-year tombstones), checked `purge_poll`, and key destruction.
  - Operator functions for `feedback_operator`: `withdraw_poll`, `set_organiser`, `live_key_refs`.
  - `operations.journal_state.last_seq` advances by exactly one per journaled change (`journal_ack`).
  - Owner draft deletion is now `delete_draft_poll(id, owner, seq)`; the unjournaled two-argument version is dropped.
- **Journal** (`journal.ts`): append-only JSONL outside the DB, chained by SHA-256, fixed member order, fsynced; each entry holds only kind, poll ID, coarse reason and time.
  - `journaled()` takes a cross-process advisory lock, checks DB/journal agreement, locks and validates the poll (`prepare`), appends, then applies and acknowledges in the same transaction.
  - `assertJournalInSync` fails closed when they differ (an interrupted change or a restored backup).
- **Operations** (`operations.ts`, `ops-cli.ts`, `npm run ops`): hourly retention with journaled purges and key-file removal after commit; operator withdrawal (journal first, then the locked change, then key destruction); a missing-key check (`check-keys [--withdraw]`); organiser provisioning against a stable Google subject; and offline `recover`.
  - Recovery replays every entry, applies tombstones, withdraws **every** poll open in the restored DB (`restored_backup`), withdraws inconsistent closed polls (or all closed polls with `--withdraw-closed`), applies retention, re-acknowledges the journal, then destroys keys.
  - A missing, torn, truncated or edited journal keeps recovery offline.
  - Opening now refuses an invalidated draft or one whose key file is missing, and never regenerates a key.
- **Demo.** `demo.mjs` keeps a local journal in `.certs/`, applies the same startup sync rule (it runs recovery itself if the local DB was wiped or restored), and schedules retention hourly plus at startup and auth-state cleanup every 30 s under a `feedback_demo_retention` login.
- **Tests** (`tests/db/operations.test.ts`, 5 tests). They were **written after the implementation, so no red is claimed.** They cover:
  - every retention boundary: key destruction at the next run while the public key and identical-retry confirmation remain; the 7-day purged DTO before deletion and the deletion itself; user cleanup; live state untouched; the 90-day access end before the purge; draft expiry; tombstone expiry; auth-state cleanup;
  - refused deletes by every request role, plus owner deletes and `TRUNCATE` of live uniqueness state;
  - withdrawal: journal order and content, closure, key destruction, claim/redeem/results all `poll_withdrawn` (including a cached snapshot), permanence, a withdrawn draft never opening, operator-only provisioning;
  - missing-key detection, and opening refused (422) without regeneration;
  - an interrupted journaled change blocking further changes and serving until recovery;
  - a **real stale backup** (`CREATE DATABASE … TEMPLATE`): after the backup, a deletion, a withdrawal, and a claim plus response that the rollback forgets. On the restored copy, serving is refused until recovery; afterwards the deleted draft stays tombstoned, the withdrawn poll stays withdrawn, the restored open poll is withdrawn with its key destroyed, the forgotten claim and nullifier are refused, the consistent closed poll stays readable, and the journal tamper cases refuse.

  `tests/db/delete-draft.test.ts` now also checks that a refused deletion writes no journal entry.
- **Mutation** (16 mutants, all killed in the end):
  - Killed on the first pass: skipping restored-open withdrawal, skipping withdraw replay, ignoring an incomplete journal, a startup check that always passes, no 7-day DTO boundary, no 90-day view boundary, owner deletes of live claims, no key marking, withdrawal leaving the poll open, a purge with no tombstone, `TRUNCATE` allowed, no key destruction after withdrawal, and an unchecked hash chain.
  - "Withdrawal reversible" survived at first because the reason CHECK constraint already blocks it whenever a reason is set; a case with no reason now kills it.
  - "Append before prepare" was killed by the new delete-draft journal assertion.
- **A test caught a real defect during the slice.** The first owner-bypass let the migration owner delete an **open** poll's key. `tests/db/foundation.test.ts` failed, and the bypass now excludes open polls everywhere.
- **Broader checks:** typecheck, build, unit 167/167, DB 59/59, `test:demo-browser` 8/8. The CLI smoke test (`check-sync`, `check-keys`) ran against the local demo DB.
- **Not established:**
  - real backup tooling, WAL archiving or 7-day backup expiry; the procedure is exercised with a database template copy only;
  - journal storage on separately protected media, and journal compaction after one year;
  - a scheduled production runner (the production server comes in a later slice);
  - core-dump and swap configuration.

**Slice 3 (production entrypoints, headers, bounds and fail-closed startup, 2026-11-08):**

- **Configuration** (`packages/config/src/production.ts`, SPEC.md §16). It refuses: non-production `NODE_ENV`; same, nested, HTTP, wildcard or development (`.test`/`.localhost`/…) hostnames; any demo, `MIN_`/`SKIP_`/`DISABLE_`/`ALLOW_` switch; a different institutional domain; `GOOGLE_SDK_NODE_LOGGING`, `NODE_DEBUG`, and `NODE_OPTIONS` inspection, profiling or report flags; missing or relative settings; shared database roles; off-host databases without `sslmode=verify-full`; a non-loopback signer; and any identity, key, signer or portal database setting in the **response** service's environment. The callback URI is derived, never configured. Errors name variables, never values.
  - `tests/unit/production-config.test.ts` red: 7/7 on the stub. Green: 7/7. Mutation: 9 mutants, all killed.
- **`packages/http`:**
  - the exact §14 CSP plus the `Referrer-Policy`, `nosniff`, `X-Frame-Options`, `Permissions-Policy`, CORP, HSTS and COOP headers. COOP is `unsafe-none` only on `/p/:pollId` and `/claim-bridge`, `same-origin` elsewhere;
  - a bundle loader that refuses symlinks, unexpected file types, a `__demo` string, and inline script/style in production;
  - immutable caching for hashed assets, `no-store` for HTML and API, no ETags;
  - an HTTPS factory with 8 KiB headers (431), a 2 KiB URI (414), and a 5 s receive timeout, plus a 10 s application budget answering `503 temporarily_unavailable`;
  - response-host ingress stripping (cookie, authorization, forwarding/client-IP, user-agent and client hints, tracing/baggage, request IDs, identity-proxy headers);
  - startup checks: secret files not group/world readable; each DB login non-privileged, non-owner, in **exactly** its runtime role, with `fsync`/`synchronous_commit` on.
- **Servers** (`services/portal-api/src/server.ts`, `services/respond-api/src/server.ts`). Before listening, the portal checks secrets, the key store, all five role logins, journal sync, signer health and the bundle. It then schedules the closer (1 min), retention plus the orphan-key sweep (hourly and at startup), and auth cleanup (30 s). The issuer pool has a 2 s statement timeout, which closes the Milestone 3 preflight-timeout residual. The response server has only its public pool and never sends `Set-Cookie`.
- **Draft admission** (§14). At most ten key-generating creations per organiser per day, with validation first so invalid input never spends the budget. Two concurrent key generations. Migration `0008_draft_limits.sql` caps retained polls at 50 per organiser under a per-owner row lock and removes the key file on that definite refusal.
- **Tests:**
  - `tests/db/production-server.test.ts` (3, real TLS listeners and five per-run login roles). Exact headers per route, cache policy, 404/414/431, API 401 and the login redirect. Every stripped header is absent from what the application sees, with no `Set-Cookie`. Startup refusals: a 0644 secret, a superuser URL, a wrong-role login, a portal login on the response server, an unhealthy signer, a `__demo` bundle, an inline-script bundle, and an out-of-sync journal.
  - `tests/db/draft-limits.test.ts` (2).
  - Both were written after the implementation, so **no red is claimed**. Mutation: 12 server mutants and 4 limit mutants, all killed.
  - The first run's "socket hang up" was the test client reusing a keep-alive socket that the server had correctly closed after the 431 (`agent: false` fixes it).
  - The `Set-Cookie` removal hook is an equivalent mutant (the response app sets none); it stays as defense in depth.
- **Vitest** now aliases `@iitgn-feedback/http` and `@iitgn-feedback/config/production` to source, as for `protocol`, so tests never run a stale `dist/`.
- **Broader checks:** typecheck, build, unit 174/174, DB 64/64.
- **Not established:** a deployed ingress/CDN/WAF honouring §14/§15; a container image and digest; core-dump and swap settings; HSTS preload; a production bundle in a real browser under CSP (next, with the redesigned UI).

**Slice 4 (the Feedback Booth design, built bundles under CSP, draft persistence, 2026-11-08):**

- **Shared UI** (`packages/ui`) from `design/`: tokens, self-hosted Geist/Geist Mono woff2 (OFL; checksums in `src/fonts/README.md`; latin subset only), CSS Modules only.
  - Components: the 5×7 `DotDisplay` (scramble-then-settle, real text as its accessible name), `StatusPlate`, buttons, `NoticePlate`/`WarningPlate`/`WithheldPlate`, LED `MarqueeLights`, `RatingKeys`/`ChoiceList` (native radios as full-size transparent overlays, keyboard operable), `StepList`, `DotBar`/`DotColumn`.
  - The isometric `Booth` and `Press` are React SVG with named animated parts. Dynamic values go only through CSSOM custom properties. Reduced motion jumps to final states.
- **Response site:** the booth panel follows the browser credential state (display `6D 08H` countdown, `SEALED`, `WAIT`, `READY`, `SEND`, `THANKS`, …; dim means idle, lit means something real happened). The privacy notice is a verbatim notice plate. The loss warning shows before claiming, and the identification warning beside every free-text field and before submitting. Answers can be drafted before claiming, and frozen answers stay visible but disabled.
- **Portal:**
  - sign-in (the Google link in production; synthetic buttons only in the dev server and the separate `dist-demo` build);
  - a `/signed-in` page, a poll list with status plates, and the editor with organiser warnings;
  - in-page dialogs: open confirms the freeze warnings; close and delete need a typed word (red);
  - dot-matrix results (scramble reveal; exact counts and percentages as text; withheld plates without numbers);
  - the claim-bridge "issuing desk": badge and title, and the press stamps only **after** "Stamp my envelope". The window close is deferred up to 3 s so the stamp finishes; in-memory state is still cleared at `stored_ack`;
  - a 404 press that stamps "404".
- **Spec wording.** The buttons are now "Prepare my credential" (SPEC.md §3) and "Stamp my envelope". Tests were updated deliberately: labels, the typed-confirmation dialogs instead of `window.confirm`, status plates' accessible names, one-decimal percentages, and frozen answers as disabled inputs.
- **Residuals closed:**
  - *Draft answers persisted (§8):* `prepared`/`claim_sent`/`usable` records carry `draft`, which is dropped at `submit_pending` and erased on acceptance. `tests/browser/draft.spec.ts` red: `draft` undefined in the record. Green in Chromium and Firefox; it also covers reload restoration, nothing in Web Storage or the URL, and no request before an explicit submit.
  - *Observed closure now updates the page* (no stale "Prepare" button).
  - *Bridge view exposes the claim outcome*, so a refusal never shows a stamp.
- **Two real bugs found by looking at screenshots:** question fieldsets had no accessible name (legend nested in a div; now `aria-labelledby`), and the booth display sat about 15 px low because the inline-flex box was on a text baseline (measured against the display rect in the browser, then fixed).
- **Demo launcher:**
  - `FEEDBACK_DEMO_SERVE=built` serves the **production bundles** itself on both HTTPS origins with the production header set.
  - `FEEDBACK_DEMO_EPHEMERAL=1` uses a fresh disposable database, journal and key directory per run, removed on exit or by the next run.
  - Six synthetic organisers exist because the new limits are working: the persistent demo DB already held 50 polls for one organiser (cap), and one suite run exceeds ten creations per organiser per day (429).
  - `playwright.demo.config.ts` now uses built plus ephemeral mode, and CI gains a `demo-browser` job (not executed: no remote).
- **CSP evidence:** `tests/demo-browser/csp.spec.ts` (Chromium and Firefox, production bundles) runs organiser, response page, claim-bridge popup, submission, 404, close and results with **zero** `securitypolicyviolation` events or page errors. Positive controls on a production page refuse inline `<script>`, string-timer eval, a `style` attribute and a remote image (no completed request). The exact CSP and `COOP: unsafe-none` on the poll page are asserted. The probe was first tried with `eval` inside Playwright's privileged `evaluate`, which bypasses CSP; it was replaced, not counted.
- **Final checks on this tree:** typecheck; build (the production portal bundle contains no `__demo`, the demo bundle does, and no `data:` URIs); unit 174, signer 31, DB 64, browser 68 (Chromium and Firefox); `test:demo-browser` 10/10.
- **Not established:** accessibility review with assistive technology, the mobile layout (spec: desktop only), and visual regression baselines.

### Milestone 7 — Walkthrough and release review

- Run the ten-eligible/five-response demo and four-response withheld demo from `SPEC.md` §17; verify in both supported browsers and review all 27 scenario records, performance limits, recovery drills, network/log captures, and actual API payloads.
- Exit for **synthetic demo:** reproducible clean-run walkthrough and acceptance evidence for local behavior, with real-OAuth/hosting gaps labelled clearly.
- Exit for **real participants:** all `SPEC.md` §18 release gates independently passed; no open blocker hidden by a demo mock or a green unit test.

## 5. Acceptance-scenario ownership

The numbers below refer to `SPEC.md` §17. A row assigns the **primary milestone that must demonstrate the scenario**, not permission to defer foundational protections; where useful, earlier work is noted. Record observed test names/commands alongside these entries as they are implemented.

| Scenario | Primary milestone | Required evidence |
| --- | --- | --- |
| 1 | 6 | Real OIDC signature/claim/nonce/domain failures and successful institutional login. |
| 2 | 3 | Stable subject and both account/email-entry claim constraints; session behavior from 6. Observed: `tests/db/claim.test.ts` (renamed account, reassigned address, stale session email). |
| 3 | 2 | Organiser ownership and role checks, revisited under production OIDC in 6. |
| 4 | 6 | Real session/CSRF/origin tests and production demo-auth exclusion. |
| 5 | 1 | RFC suite/encoding vectors, native signing, browser/server interoperation. |
| 6 | 4 | Distinct keys and attempted hidden cross-poll issuance/redeem; key-isolation proof begins in 3. Observed: `tests/db/redeem.test.ts` (hidden B message signed by A refused at A and B), `tests/db/claim.test.ts`. |
| 7 | 4 | Malformed credentials/messages/answers cannot create a response. Observed: `tests/db/redeem.test.ts`, `tests/db/respond-api.test.ts`, `tests/unit/answers.test.ts`. |
| 8 | 3 | Concurrent claim and crash-window database/signer tests. Observed: `tests/db/claim.test.ts` (8-way and shared-entry races, lost commit ack, killed backend, post-commit signer failure/fault), `tests/browser/claim.spec.ts` (lost bridge result never re-claims). |
| 9 | 3 | Draft/closed/expired/withdrawn issuance rejection and key restart behavior. Observed: `tests/db/claim.test.ts` (state rejections, lock-wait race), `tests/db/claim-api.test.ts` (restart keeps key; missing key fails closed, no regeneration). |
| 10 | 4 | Parallel identical/different-answer redemption and nullifier uniqueness. Observed: `tests/db/redeem.test.ts` (6-way races, alternate preparation of one secret). |
| 11 | 4 | Server answer validation, normalization, and idempotency. Observed: `tests/unit/answers.test.ts`, `tests/db/redeem.test.ts` (reordered/re-spaced replay). |
| 12 | 4 | Lost-acknowledgment and deadline-crossing retry semantics. Observed: `tests/db/redeem.test.ts` (lost ack, advisory-lock wait past the deadline), `tests/browser/submit.spec.ts`. |
| 13 | 4 | Real DB claim/submit/close race; results finalization completed and rechecked in 5. |
| 14 | 2 | Draft revision/freeze and open/edit race with DB roles. |
| 15 | 1 | Real-browser cookie and hostname isolation captures. |
| 16 | 3 | Full bridge/store failure modes; basic handoff proof begins in 1. Observed: `tests/browser/{bridge,claim,claim-interruptions,popup-blocker}.spec.ts`; a response tab closed mid-claim is not yet covered. |
| 17 | 4 | Browser prepared/usable/pending/terminal cleanup and no-secret transport checks. Observed: `tests/browser/{claim,submit,draft}.spec.ts` (draft answers persisted in IndexedDB only, erased on acceptance). |
| 18 | 5 | Malicious organiser/answer content, CSP, opener, and rendering checks; safe rendering starts in 2. Observed: `tests/demo-browser/{results,poll-content,csp}.spec.ts` on the production bundles under the enforced CSP (zero violations; inline script/eval/style attribute/remote image refused). |
| 19 | 6 | Persistence and real ingress/app/native signer/error log review; enforce safe defaults from 1 onward. |
| 20 | 6 | Full runtime role/function privilege checks; establish foundational DB roles in 2. |
| 21 | 5 | Poll/question threshold boundaries and withheld DTOs. Observed: `tests/db/results.test.ts`, `tests/demo-browser/results.spec.ts`. |
| 22 | 5 | Aggregation, skipped answers, stable independent text order, actual JSON shape. Observed: `tests/db/results.test.ts`, `tests/db/results-api.test.ts`. |
| 23 | 5 | Immutable policy, withheld permanence, export/filter denial, withdrawal snapshot gating; operations in 6. |
| 24 | 6 | Overload, limiter privacy, and timeouts. |
| 25 | 6 | Retention, browser expiry, deletion, and backup schedule. |
| 26 | 6 | Backup rollback/withdrawal journal/key-loss drills. |
| 27 | 7 | Full synthetic walkthrough and below-threshold example. Observed (synthetic, local): `tests/demo-browser/results.spec.ts`; the Milestone 7 review is still to do. |

## 6. First execution decision

Begin with **Milestone 0.1**: preserve the two documents, initialize version control, and establish the minimal npm workspace. Do not generate a full application or add an extensive test suite before the runner and Phase 0 feasibility checks work. After Milestone 0 passes, the first behavior-driven red should be the independent credential-byte fixture in Milestone 1.1; the next major stop/go decision is the native blind-signing/browser interoperability proof.
