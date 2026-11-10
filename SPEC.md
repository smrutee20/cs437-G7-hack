# IITGN Anonymous Feedback & Polls — Implementation Specification v1.0

## 1. Status, purpose, and non-negotiable guarantees

This document is the MVP implementation contract. Product and protocol choices are settled below; implementation must not silently weaken them. External configuration and compatibility checks are release gates, not unanswered product questions. No implementation, security audit, interoperability result, or IITGN OAuth authorisation is claimed by this document.

The product supports low-stakes course feedback, mess feedback, and club/council opinion polls. It is **not an election system** and must not be used for binding student-body elections, disciplinary decisions, or other high-stakes decisions.

### Core guarantees

1. At most one credential may be obtained per eligible institutional **account** per poll, and at most one claim may consume an allowlisted email entry. This is not a one-human-one-vote guarantee: one person may control multiple institutional accounts.
2. A valid credential can create at most one accepted response. Identical retries may confirm that response but never add another one.
3. Response records contain no account identity or respondent-level linkage to issuance records. Organiser features expose no individual claim status, response rows, or identity-to-answer mappings. An organiser participating in their own poll receives only the same self-claim/submission outcomes as any other participant.
4. Issuance uses RFC 9474 blind signatures with a **different key pair for every poll**. Ordinary bearer tokens, JWTs, stored token hashes, and shared signing keys are not substitutes.
5. Results are organiser-only, unavailable until final closure, and subject to the publication rules in §11. These are risk-reduction policies, not mathematical anonymity guarantees.
6. The platform operator, signer, database administrator, identity provider, and deployment infrastructure are trusted within the boundaries below. Blind signatures do not prevent a dishonest issuer from minting extra credentials.

“MUST”, “MUST NOT”, and “REQUIRED” describe acceptance requirements. Changes to these guarantees require an explicit specification revision before implementation or deployment.

## 2. Settled MVP decisions and scope

| Topic | Decision |
| --- | --- |
| Authentication | Server-side Google OIDC authorization-code flow; institutional Google Workspace accounts only; no Google frontend SDK. |
| Institutional domain | Production email domain and expected Workspace `hd` are both `iitgn.ac.in`. Verify these against real institutional tokens before release. A different actual domain requires a reviewed configuration/specification change, not a suffix wildcard or verification bypass. |
| Organisers | Operator-provisioned organiser accounts; no public organiser registration, delegated roles, or organiser invitation feature. |
| Eligibility | Organiser-supplied exact-email list; at least one distinct normalized entry, no policy maximum (request-size bounds still apply); no roster discovery. |
| Poll lifecycle | Manual opening, automatic deadline closure, optional earlier manual closure; closed is terminal. No scheduled opening, reopening, deadline extension, or post-opening content changes. |
| Questions | 1–20 questions; at least one required structured question. Single-choice and integer 1–5 ratings; at most three optional free-text questions. |
| Free text | Disabled by default for a new poll; an organiser may explicitly enable it before opening. Free-text questions are always optional. |
| Publication | New polls (policy v2) require at least one accepted response per poll and one nonempty answer per published question. Previously opened policy-v1 polls retain their frozen five/five thresholds; editable drafts adopt v2. Exact structured counts are permitted; a single answer or eligible person can be identifiable. |
| Credential recovery | No replacement credential and no new signing operation for a consumed claim, even after network or browser failure. |
| Submission retry | Same credential plus the same canonical answers returns success; different answers return a spent-credential conflict. No answer editing. |
| Browser support | Current stable desktop Chromium and Firefox, with HTTPS, Web Crypto, IndexedDB, and Web Locks. Unsupported/blocked storage or APIs prevent claiming. Mobile/Safari support is not claimed until separately tested. |
| Deployment | Two distinct HTTPS hostnames, including in local development; APIs are served under their respective frontend hostname. |
| Stack | React, TypeScript, Vite; Node.js 24 LTS, Fastify, PostgreSQL 17, Drizzle migrations; an isolated native-RSA signer as specified in §6. |
| Exports | No response export, segmented export, cross-tabulation, public results page, or individual-response inspection. Visible results can still be manually copied; this is not a copy-prevention feature. |
| Retention | Identity-side poll data: seven days after closure. Responses/results: 90 days. Backup expiry and exceptions are specified in §15. |

Out of scope: mandatory participation; guaranteed anonymity against operators, network observers, browser compromise, colluding participants, or identifying answer content; credential non-transferability; lost-credential reissuance; attachments; HTML/Markdown content; rich branching; automatic reminders based on claims; public election verification; differential privacy; and coercion resistance. Repeated/overlapping polls and outside knowledge can also enable inference; publication thresholds do not prevent those attacks.

## 3. User journeys and required disclosures

### Organiser

1. Sign in to the portal using an authorised organiser account.
2. Create and edit a draft, import/paste eligibility, configure questions and deadline, and preview using synthetic answers only. Preview cannot issue a credential or create a response.
3. Review warnings: questions will be publicly readable by anyone with the invitation link; eligibility does not make questions confidential; free text and a single eligible person or answer can identify authors; new polls with zero responses have results permanently withheld (existing polls keep their frozen policy); content, eligibility, deadline, key, and publication policy cannot change after opening.
4. Open the poll and share `https://<response-host>/p/<pollId>`. The random poll ID is a public locator, not an authentication credential.
5. Close early if desired. The confirmation explains that closure is irreversible and may leave results withheld; it does not reveal live response/claim counts.
6. After closure, view threshold-compliant results or a clear “closed; insufficient responses; results permanently withheld” state. No force-publish override exists.

### Participant

1. Open the response site without signing in. Read the public questions, deadline, privacy notice, and credential-loss warning. Answers may be drafted before claiming.
2. If needed, sign in on the separate portal and return to the response tab. Authentication never occurs on the response origin.
3. Choose “Prepare my credential”; the response site creates and stores the blinded-request state. Once ready, choose “Open claim window” to open the portal bridge within a fresh browser user gesture. The bridge shows the signed-in account and poll and requires explicit confirmation before consuming the entitlement.
4. Receive the blind signature through the browser-only bridge; unblind, verify, and persist the usable credential on the response origin. No identity or usable credential is handed to the other service.
5. Review and submit. An uncertain submission outcome offers retry of the exact saved submission, not a fresh claim or editable replacement.
6. On confirmed acceptance, erase the local credential and saved answers. Show a generic success screen, not a publicly verifiable receipt or response ID.

A forwarded invitation does not grant eligibility. A forwarded bearer credential can be used by its recipient first. A consumed claim with a lost credential cannot be repaired in this poll; creating a replacement poll is an organiser decision affecting everyone, not a secret per-account exception.

### Mandatory participant wording

> Your institutional account is checked to issue one credential. The response service does not require sign-in, and answers are not stored with your account identity. A credential can be used once and can be lost or shared. Do not include identifying details in your answers. A single eligible participant or answer may identify you to the organiser. Free text, small result categories, outside knowledge, and network metadata may reveal you. The platform and its infrastructure must be trusted. This is not an election system or a guarantee of absolute anonymity.

Show the loss warning before claiming and the content-identification warning next to every free-text field and before submission. Never claim that the organiser cannot make inferences from answer content.

## 4. Poll lifecycle and concurrency contract

### States and immutable fields

| Stored state | Allowed actions | Transition |
| --- | --- | --- |
| `draft` | Owner reads/edits/previews/deletes; no public metadata, claims, responses, or results. | Owner opens to `open`, or deletes. |
| `open` | Eligible accounts claim; valid credentials submit; owner reads configuration or closes. No results or live counts. | Deadline or manual close changes to `closed`. |
| `closed` | Owner reads gated results; valid identical submission retries may confirm existing responses. No new claims/responses. | No reopening. Retention purge only. |

An operator may invalidate a poll for key loss/compromise, restored database state, or integrity failure. Invalidation closes it if necessary, sets `invalidated=true`, and permanently withholds results and submission confirmations. Previously viewed results cannot be recalled. Public UI says the poll was withdrawn and must not be relied upon. This is not an organiser-accessible override.

Opening freezes title, description, question and option IDs/order/content, eligibility, `closes_at`, policy version/thresholds, key ID/version, and public key. Enforce immutability in database constraints/triggers as well as application code. The owner cannot supply or replace a signing key.

Opening is immediate, with `opened_at` set by the database. At opening, `closes_at` must be between ten minutes and 30 days in the future. Store UTC instants using `timestamptz`; APIs use RFC 3339 UTC timestamps ending in `Z`. Display both the user's local timezone and the exact deadline. Client clocks never authorize an operation.

### Effective closure and acceptance ordering

- Effective status is closed if stored status is closed, or if stored status is `open` and database `clock_timestamp() >= closes_at`. A draft with a past proposed deadline remains a draft and can be edited. Expiration of an open poll does not depend on a scheduler being timely. A scheduler materializes expired closure at least once per minute; relevant server operations can also materialize it.
- For deadline closure, effective `closed_at = closes_at`. Manual closure uses the database time, capped at `closes_at` if the deadline already passed. Purge dates use this effective closure time.
- New claims and new response insertions acquire a shared row lock on the poll, then check state, invalidation, and `clock_timestamp() < closes_at` while holding that lock through commit. Use a lock compatible with other claim/submission readers but incompatible with poll closure, such as `SELECT ... FOR SHARE`.
- Closing/invalidation takes an exclusive conflicting poll row lock. Use the same lock order everywhere: poll, then the redemption advisory lock where applicable, then entitlement/claim or response. The claim and response transactions use PostgreSQL `READ COMMITTED` with these explicit locks; isolation level alone is not the guarantee.
- Redemption also takes a transaction-scoped advisory lock for the poll/nullifier **before** looking for an existing response. Define its signed 64-bit key as the first eight bytes of `SHA256(ASCII("IITGN-FEEDBACK-REDEEM-LOCK\0") || UUID_BYTES(pollId) || nullifier)`, interpreted as big-endian two's complement. Use `pg_advisory_xact_lock` with the stated lock timeout; acquire it in a separate statement before the response lookup so the lookup gets a fresh snapshot. This serializes same-credential attempts, including a retry just after the deadline while an earlier accepted insertion is still uncommitted. Hash collisions only serialize unrelated attempts; they do not establish uniqueness or spend a credential. Locks and lock keys are not application-log data.
- An acceptance decision is linearized at the successful locked state/deadline check immediately preceding the insertion, conditional on a successful durable commit. A request that has not reached that point before the deadline fails. A request accepted before the deadline may finish committing or return its HTTP response afterward.
- Do expensive signature verification, key generation, and external I/O outside the locked database transaction. Recheck all mutable state under the lock. Bound transaction duration and lock waiting to two seconds; an aborted transaction cannot return success.
- Before publishing results, take the conflicting closure lock and materialize closure. This waits for previously admitted transactions to commit or abort, giving a stable final response set even if the deadline passed during an in-flight request. No results computation from an unlocked “deadline passed” snapshot.
- A committed claim may finish signing after closure; its credential then cannot add a response. Warn users not to claim at the deadline. The signer must not reopen or extend the poll.

## 5. Identity, eligibility, and authorisation

### Google OIDC

Use the server-side authorization-code flow with `openid email` scopes, PKCE S256, a 256-bit random `state`, and a separate 256-bit `nonce`. Bind the single-use state to a 256-bit random `__Host-preauth` cookie (`Secure; HttpOnly; SameSite=Lax; Path=/`, no Domain, ten-minute lifetime) and server-side transaction, expire it after ten minutes, and use an exact registered portal callback URI. Permit only allowlisted relative portal return paths. No implicit flow, Google frontend JavaScript, offline access, or refresh-token storage.

Use Google's maintained server verification library with a pinned dependency version. Verify the RS256 signature against Google's rotating keys, `iss`, exact single-string `aud` equal to this client ID, `exp`, `iat`, nonce, nonempty `sub`, `email_verified === true`, exact institutional email domain, and exact signed `hd === "iitgn.ac.in"`. Reject other algorithms, multiple audiences, and an `azp` claim identifying any other client. Reject an `iat` in the future beyond the permitted clock skew. Permit at most 60 seconds of clock skew. Reject missing/wrong `hd`, even when an email suffix and `email_verified` look correct. OAuth's `hd` request parameter is only a UI hint, not evidence.

Accept Google's documented issuer spellings but normalize persisted issuer to `https://accounts.google.com`. Bind an application user uniquely to `(issuer, sub)`, never to a mutable email alone. Store only the verified account fields needed for this application; discard ID/access tokens after verification and session establishment. Authentication demonstrates the account at sign-in, not continuous enrollment or account ownership throughout the poll.

Google's one-time authorization code and opaque state may appear in the dedicated callback query as required by the code flow. Disable callback request/query logging, send `Cache-Control: no-store` and `Referrer-Policy: no-referrer`, and immediately redirect to a clean portal URL before rendering assets. **Anonymous credentials, secrets, signatures, ID/access tokens, and session tokens must never appear in URLs or history.** The OAuth callback is not a credential-handoff mechanism.

Portal sessions use a 256-bit random opaque server-side session token and a separate 256-bit synchronizer CSRF token. Send the session token in `__Host-session` with `Secure; HttpOnly; SameSite=Lax; Path=/` and no `Domain`. Store only a hash of the session token. Sessions expire absolutely after eight hours and rotate on login; logout is a CSRF-protected POST that invalidates the session. No session or authentication state is shared with the response origin.

### Eligibility and account changes

- Accept ASCII institutional email addresses only: one `@`, a 1–64 byte local part composed of letters, digits, `.`, `_`, `+`, or `-`, no leading/trailing or consecutive dots, and exact domain `iitgn.ac.in`. Maximum full length is 254 bytes.
- Normalize by trimming surrounding ASCII whitespace and lowercasing the address. Do not strip dots or plus tags, resolve aliases, expand groups, or infer alternate addresses. Match the current verified primary email returned by Google exactly after normalization.
- Import newline-separated addresses or an RFC 4180 single-column CSV with an optional `email` header. Reject extra columns and invalid/non-institutional rows; imports are all-or-nothing. Deduplicate normalized addresses and report input/unique counts and invalid row numbers without logging their contents.
- A claim consumes both the stable account entitlement and one frozen eligibility entry. Enforce `UNIQUE(poll_id, user_id)` and `UNIQUE(poll_id, eligibility_id)` in claims. A renamed account cannot claim again under another listed address; a reassigned email cannot consume an already-used eligibility entry with a new subject.
- A user email is an attribute, not a globally unique identity key. Update it on subsequent verified login without changing `user_id` or old claim associations. Do not expose identity mappings to organisers.
- Deleting/recreating an application user or deleting live claims to “reset” eligibility is forbidden. Account erasure requests must follow retention or first withdraw affected live polls; they cannot create a new entitlement.

### Organiser and route permissions

The operator provisions organiser status against a verified stable account identity using a protected administrative command; there is no client-settable role field or public role-grant endpoint. Initial demo organisers are explicitly provisioned in the appropriate environment.

Every owner route requires `poll.organiser_id === authenticated_user.id`. The organiser flag allows creating polls, not reading or managing other organisers' polls. Return `404` for unknown or non-owned poll IDs on owner routes. Claims use the authenticated participant identity, not an identity supplied in the request. An organiser can participate only if their account is also in the frozen allowlist, and then follows the same limits.

All authenticated mutations require JSON, an exact portal `Origin`, and a session-bound synchronizer CSRF token in `X-CSRF-Token`. `SameSite=Lax` is additional protection, not the entire CSRF policy. No mass assignment of owner, status, keys, thresholds, user IDs, or role flags.

## 6. Architecture, crypto implementation, and key management

```text
portal HTTPS host                         response HTTPS host
React organiser/login/claim bridge        React anonymous form + credential storage
          | same-origin API                         | same-origin API; credentials: omit
Node admin/issuer API                     Node public verifier/submission API
          |               PostgreSQL               |
          |     separate DB roles and functions    |
private native-RSA signer                 no identity-table or private-key access
```

### Isolation and selected dependencies

- Use distinct production hostnames under a domain controlled for this deployment, e.g. `portal.feedback.example` and `respond.feedback.example`. Do not share parent-domain cookies with unrelated applications.
- Local development uses HTTPS on `portal.feedback.test` and `respond.feedback.test`, mapped to loopback with a trusted development certificate. Different ports alone are **not** cookie isolation.
- Each frontend calls only `/api/v1` on its own origin. Do not put the public submission API behind the portal host or an authenticated shared gateway. Run separate API processes/database credentials even if on one machine.
- Use `@cloudflare/blindrsa-ts` **0.4.6**, pinned without a version range and with lockfile integrity, for RFC 9474 preparation, blinding, finalization, and verification. The selected suite is `RSABSSA-SHA384-PSS-Randomized`. Do not use the partially blind protocol or implement RSA/PSS arithmetic yourself.
- The library's ordinary JavaScript big-number private signing path is not the production signer. Run its native `RSA-RAW` signing path in an isolated, self-hosted `workerd` process, enabling the actual library option `supportsRSARAW: true`. Pin the tested runtime release and container digest in the implementation lockfiles. Browsers and the verifier do not need `RSA-RAW`.
- The signer is private loopback/local-service infrastructure, not a third public origin or CDN Worker endpoint. Only the issuer can call it, with an independent service credential; no browser or response-service access. Do not allow inbound public routing. Private signer request/response bodies and errors are never logged.
- Generate per-poll keys using Node's native OpenSSL-backed key-generation API. Persist the private PKCS#8 key in an encrypted, access-controlled server secret volume, separate from Postgres and frontend assets. The issuer supplies that key to the native signer over a loopback-only listener or mutually authenticated TLS if a private network hop is necessary; the signer imports it for the operation and has no identity or response database access. Disable automatic RPC/proxy retries. Do not persist private keys in signer request queues.
- Private signer contract: `GET /health` exposes only readiness to the issuer; `POST /blind-sign` requires the service credential and JSON `{privateKeyPkcs8,blindedMessage}`, both canonical unpadded base64url, with a 16 KiB body limit. On success return only `{blindSignature}`; otherwise a generic bounded error. Import the key as native `RSA-RAW` for the library's signing path, require 3072-bit RSA/exponent 65537, and verify input size/range and output fault check. This service never performs PSS preparation itself, since the client has already blinded the PSS-encoded message. No key, signature, or detailed native exception is returned on failure.
- Phase 0 must verify the native path's input checks, private-operation side-channel protection, and RSA fault check. Native private operations must be checked against the expected public operation before release. An independent public-operation check using an existing native/library primitive is permitted; custom modular arithmetic or a silent fallback to JavaScript private exponentiation is not.

Library selection is settled, but suitability is not assumed: browser bundling, native signing, exact runtime flags, test vectors, security review of the selected path, and interoperation must pass §18. If they fail, stop and revise the spec explicitly; do not ship a weaker substitute under the same promises.

### Key lifecycle

- RSA modulus: **3072 bits**; public exponent: **65537**. SHA-384 for PSS and MGF1; PSS salt: **48 bytes**; randomized preparation prefix: **32 bytes**.
- Generate a fresh independent key pair for each draft. Creation succeeds only after the private key is durably stored and its public key/reference is committed. Clean up orphaned unpublished keys after failed creation.
- The public-key ID is a server-generated UUIDv4; `keyVersion` is integer `1` for MVP. Key IDs and key pairs are never shared across polls, environments, authentication, TLS, or other protocols. The public-key fingerprint is the SHA-256 RFC 7638 JWK thumbprint, using canonical member order `e,kty,n`; database uniqueness prevents attaching the same key to multiple polls.
- Publish the same poll key/parameters to every participant; never select them by identity. Public JWK contains only `kty: "RSA"`, canonical unpadded base64url `n` (384 bytes), and `e: "AQAB"`. Import using RSA-PSS/SHA-384; no client algorithm negotiation or client-supplied verification key.
- The verifier always chooses the expected key from the requested poll, then compares the credential key ID/version. Including a poll ID inside a blinded message does not bind an issuer's eligibility decision when keys are shared; shared keys are forbidden for that reason.
- No mid-poll rotation, replacement, or regeneration, including after process restart. Key loss/compromise withdraws the affected poll. An organiser cannot override this.
- Destroy live-store private keys within 24 hours of closure; keep public keys until response retention expires so existing submissions can be confirmed. Encrypted backup copies expire on the backup schedule. No private key is necessary for results.

## 7. Exact credential and answer encodings

### Common wire rules

API bodies are UTF-8 JSON objects with no duplicate member names or unknown fields. Reject unsupported versions and wrong primitive types; do not coerce numeric strings. Binary fields are canonical RFC 4648 base64url without padding or whitespace; decode and re-encode to check canonicality. UUID strings are lowercase canonical UUIDv4 strings; UUID bytes are the 16 octets in displayed hexadecimal order, not a platform GUID's mixed-endian representation.

### Credential message, protocol version 1

Let `secret` be 32 fresh bytes from `crypto.getRandomValues`. Concatenation below is of bytes, not JSON or textual hex:

```text
application_message =
    ASCII("IITGN-FEEDBACK-CREDENTIAL\0")  # 26 bytes, including final zero byte
    || 0x01                              # protocol version
    || UUID_BYTES(pollId)                # 16 bytes
    || UINT32_BE(1)                      # keyVersion
    || secret                           # 32 bytes

prepared_message = RFC9474.PrepareRandomize(application_message)
                 = random_prefix_32_bytes || application_message

nullifier = SHA256(
    ASCII("IITGN-FEEDBACK-SPENT\0")       # 21 bytes, including final zero byte
    || 0x01
    || UUID_BYTES(pollId)
    || secret
)
```

`application_message` is exactly **79 bytes**; `prepared_message` is exactly **111 bytes**. The blind request, blind signature, and final signature are each exactly **384 bytes**. The issuer and signer require the blinded representative to satisfy `0 < m < n`, with no truncation or modular reduction of an out-of-range input; wrong sizes/ranges are rejected before claim consumption. Native verification also enforces signature representative bounds.

Verify the final signature over all 111 prepared bytes with the fixed suite. Only after verification parse and validate the application tag, version, requested poll ID, and key version. The verifier checks the message grammar, not just the signature. The nullifier deliberately excludes the preparation prefix and signature: alternate signatures/preparation for the same poll/secret cannot create another response.

Credential wire object:

```json
{
  "version": 1,
  "keyId": "<poll's UUIDv4 key ID>",
  "keyVersion": 1,
  "preparedMessage": "<111 bytes as unpadded base64url>",
  "signature": "<384 bytes as unpadded base64url>"
}
```

The browser stores the complete prepared message, including its randomizer. It must not attempt to reconstruct that randomizer from the secret. All randomness, including blinding factors and PSS salt, comes from the library/CSPRNG; there are no production seed or caller-controlled randomness options.

### Encoding fixture (not a credential or a production random seed)

For poll `123e4567-e89b-42d3-a456-426614174000`, key version `1`, and secret bytes `00 01 ... 1f`:

```text
application_message_hex =
494954474e2d464545444241434b2d43524544454e5449414c0001123e4567e89b42d3a45642661417400000000001000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f

nullifier_hex =
5b42afa082f7f1fdcd75b36ffe14923fe7a9759a8971e8223b3d1e2c300d973c
```

Test this encoding fixture independently in browser/server code in addition to the RFC signature test vectors. It does not replace those vectors.

### Questions and canonical answers

A question is `{id, type, prompt, required}` and, only for `type: "single_choice"`, `options: [{id, label}]`. Types are `single_choice`, `rating`, and `free_text`. IDs are UUIDv4 values unique across all questions/options within a poll; array order is presentation order. Draft edits preserve IDs for the same item; new items receive new IDs. The server validates these client-generated item IDs; poll/key IDs are always server-generated.

Limits after text normalization:

| Field | Limit/rule |
| --- | --- |
| Title | 1–120 Unicode code points, at most 480 UTF-8 bytes. |
| Description | 0–2,000 code points, at most 8,000 bytes. |
| Question prompt | 1–500 code points, at most 2,000 bytes. |
| Choice options | 2–10; each label 1–120 code points/480 bytes; normalized labels must be distinct within the question. |
| Rating | An actual JSON integer in `[1,5]`; no zero, decimals, string coercion, or implicit abstention value. |
| Free text | 0–2,000 code points/8,000 bytes; always optional; at most three such questions. |
| Whole poll | 1–20 questions, at least one required structured question, and at least one eligible entry (subject to the request-size bound). |

For all human text: reject invalid Unicode/unpaired surrogates; convert CRLF/CR to LF, normalize to NFC, trim using ECMAScript `String.prototype.trim` whitespace rules, and reject Unicode category `Cc` control characters except LF/TAB. Apply byte and code-point bounds after normalization, with the HTTP size bound also enforced before parsing. Render as escaped plain text; preserve internal whitespace. No HTML, Markdown interpretation, embeds, or automatic links.

Submission answers are `[{questionId, value}]`. Single-choice values are an option UUID from that question; ratings are integers; text values are strings. Reject duplicate/unknown question IDs, unknown option IDs, invalid types, extra fields, and missing required answers. Omit skipped optional questions; an empty normalized optional text answer is also omitted. `null` is not an answer value. An all-empty submission is invalid, and a valid poll's required structured question ensures at least one real answer.

Canonical answers are the validated/normalized entries ordered by the frozen question order, with only `questionId` and `value` retained. Store this canonical array as JSONB. Idempotency compares semantic equality of these canonical arrays, not request byte order, JSON whitespace, or a client-provided digest. Do not persist the raw request body.

## 8. Browser storage and portal bridge protocol

### Origin ownership and persistence

The response origin alone generates the secret, prepares/blinds the message, unblinds the signature, and stores the credential. The portal sees only the public poll/key identifiers, blinded request, and blind signature. No usable credential, secret, unblinding inverse, answer, email, account ID, or OAuth token crosses the bridge in the wrong direction.

Use IndexedDB, not URLs, `window.name`, clipboard handoff, session cookies, or server storage, for participant state. Use a Web Lock named by poll ID plus atomic IndexedDB transitions to coordinate tabs. Read back a newly saved record before allowing the irreversible claim. If storage or the lock API is unavailable, refuse to claim and explain why. Best-effort persistence cannot survive browser data clearing, eviction, device loss, or compromise; disclose this.

Persist these per-poll states:

- `prepared`: expected poll/key/expiry, prepared message, blinded message, unblinding inverse, and local draft answers. Safe to discard before any request attempt.
- `claim_sent`: same data; written durably **before** handing the blinded request to the portal. No automatic new claim after reload or an ambiguous outcome.
- `usable`: credential object and draft answers. Erase the blinding inverse/blinded request once the usable credential is persisted and read back.
- `submit_pending`: credential and exact canonical answers being submitted. Freeze answer editing until the outcome is known. Retries reuse this snapshot.
- Terminal local marker: non-secret status such as `accepted`, `spent`, or `claim_uncertain`; no response ID. Delete all secret material and answer drafts when appropriate below.

Do not overwrite another tab's prepared/usable credential. Broadcast only non-secret state-change notifications; other tabs reread IndexedDB. Server uniqueness remains authoritative even if browser coordination fails.

### Authentication and popup behavior

Login and the live bridge are separate flows. If not signed in, authenticate in a portal tab first and return to the response tab. The bridge may indicate `login_required`, but must not navigate a live signing handshake through Google. If the session expires, no claim is consumed; sign in separately and reconnect.

After asynchronous preparation/storage finishes, present a separate “Open claim window” button and synchronously open the bridge in that fresh user gesture at the fixed portal URL `/claim-bridge?pollId=<public poll ID>`. Do not assume browser popup permission survives awaited crypto/storage work. The public poll ID may appear in this URL; no secret or per-participant channel value may. Blocked popups produce a recoverable instruction and do not trigger a claim.

The response window keeps the returned `WindowProxy`. The bridge retains `window.opener`. Preserve the opener for these pages with compatible COOP behavior (`unsafe-none` for response/bridge); do not accidentally sever it with `same-origin` or `noopener` on this bridge. Other external links use `noopener noreferrer`; neither app may be framed. Test real browser behavior rather than assuming the headers work.

### Message contract

Every message is a strict object with `version: 1`, `type`, and `pollId`. On each connection the response window creates a fresh 32-byte random `channelNonce` in memory. It is a browser-only handshake value and is never sent to an API, URL, log, or persistent record.

1. Bridge sends `bridge_ready` with no identity data. Response checks exact portal `event.origin` and `event.source === openedWindow`, then sends `bridge_init` with `channelNonce` and expected `keyId`.
2. Bridge accepts init only from its exact configured response origin and `event.source === window.opener`, checks poll/key against portal data, and replies `bridge_ack` echoing the nonce. A direct visit without an authenticated, valid opener cannot claim through the bridge.
3. After acknowledgment and durable `claim_sent` storage, response sends `claim_request` containing nonce, key ID/version, and blinded message only. Bridge accepts one request for this channel, presents its explicit account/poll confirmation, and makes at most one HTTP claim attempt.
4. Bridge returns `claim_result` containing nonce and either `blindSignature` or a documented error code. It must not send identity-dependent signed data or profile fields. If the user cancels before any HTTP attempt, return `not_attempted`, permitting the response state to return to `prepared`.
5. Response validates source, origin, nonce, poll, and key; finalizes and verifies locally; persists and reads back `usable`; then sends `stored_ack`. Bridge clears in-memory request/signature state and closes. It may resend the **same in-memory result** for up to two minutes while awaiting acknowledgment, but must never repeat the server signing request.

All `postMessage` calls use the exact fixed target origin, never `*`. Require at most 2 KiB serialized data per bridge message and canonical base64url for nonce/signature/blinded bytes; the nonce is exactly 32 bytes. Reject unexpected message types, sizes, fields, source windows, nonces, polls, or keys. No `MessagePort`/frame/open-redirect workaround may weaken these checks. Closing/reloading either window during an irreversible attempt may strand the claim; preserve an explicit uncertain state rather than silently generating a new credential.

A first attempt rejected definitively before claim insertion (`not_attempted`, missing login, CSRF/input/eligibility failure, rate limit, or pre-consumption capacity failure) may return to `prepared` for an explicit user retry after correction. A consumed-claim result is terminal for this browser unless it already holds a usable credential. A network/commit uncertainty stays in `claim_sent` while the original bridge can still return its one result; after the two-minute window, erase the stranded secret/blinding state and retain only `claim_uncertain`. A later generic error does not prove an earlier uncertain attempt was unspent. Never discard another tab's already-usable credential as part of this transition.

### Cleanup and confirmation

On `201 accepted` or `200 accepted`, delete credential, prepared state, inverse, pending answers, and drafts before showing success; retry local deletion if needed. On valid `credential_spent` with different answers, delete the credential/pending answers and explain that this credential cannot submit the current answers; do not claim those answers were recorded.

If the first submission attempt receives a definitive pre-insert validation/input rejection, return to `usable` so the participant can fix the answers; a first-attempt rate/capacity rejection permits explicit retry. Once any attempt has an uncertain outcome, retain `submit_pending` and the exact payload until accepted, spent, or terminally rejected; a later rate/capacity error does not prove the earlier attempt failed. `410 poll_closed`, `410 poll_withdrawn`, or a confirmed purged `404` is terminal and erases secret/pending state. Invalid-credential errors require an explanatory failure screen, not a new signing request.

Refresh public status when reopening a saved poll and before a new claim/submission. Erase unused credentials on observed closure, withdrawal, or expiry. A `submit_pending` record may be retained for confirmation until 24 hours after effective closure, then must be erased even if the outcome remains unknown. Sweep on app start, poll load, and while an app tab remains open. A closed browser cannot be remotely scrubbed: expired entries are erased on the next run, and users can clear site data themselves. Non-secret local terminal markers expire seven days after closure.

## 9. Issuance transaction and failure semantics

The public-to-browser claim endpoint is portal-authenticated; the native signer is never browser-accessible.

1. Enforce session, CSRF/origin, request limits, fixed key/suite, and valid blinded-input encoding/range. Reject unknown/draft polls and known closure/withdrawal before loading a private key or reserving signer work; the locked check below remains authoritative. Ensure the signer is healthy and reserve bounded signing capacity **before** consuming an entitlement. A preflight failure must not intentionally create a claim.
2. Begin a database transaction, lock the poll as in §4, and check it is open, not expired, and not invalidated. Resolve the current verified email to the frozen eligibility entry. Insert a claim with both unique account and eligibility constraints. Do not use “check, sign, then insert”.
3. Commit durably with PostgreSQL `fsync=on` and `synchronous_commit=on`. Only a definitely successful commit allows signing. An ambiguous commit result means **do not sign**; never delete the claim as compensation.
4. After commit, invoke the native signer once for this request and release only the verified blind-signature result. No HTTP success or signature may be sent before the claim commit. Issuance persists no blinded request/hash, blind signature, unblinded message/signature, request-channel nonce, or response identifier.
5. Any duplicate claim gets `409 claim_consumed`. Any post-commit signing failure gets `503 claim_consumed_no_credential` when the server can determine that fact. A lost connection can leave the browser uncertain; no automatic claim retry or replacement is allowed.

The intentionally minimal claim row means there is no recovery/signature-replay cache. Same-blinded-request recovery could be a future protocol revision, but is not secretly implemented in MVP. A fail-closed claim counts neither as a response nor toward publication thresholds.

## 10. Redemption, retries, and failure semantics

`POST /api/v1/polls/:pollId/responses` carries `{credential, answers}`. It requires no sign-in, identity field, session, or cookies. The browser uses `credentials: "omit"`. Do not accept the credential through query parameters, URL fragments, cookies, or `Authorization` headers.

1. Apply size and resource bounds; parse strict schemas. Fetch the poll's expected public key. Draft/unknown/purged polls return `404`. Check key ID/version, full signature and prepared-message grammar; calculate the nullifier. Invalid credential failures use a generic `400 invalid_credential`, without issuer/eligibility details.
2. Validate and canonicalize answers using the frozen schema. A validation failure does not consume the credential. Do not store a nullifier before the answer insert transaction.
3. Begin a transaction and take the poll shared lock. If invalidated, return `410 poll_withdrawn`, including for retries. Otherwise acquire the §4 transaction-scoped poll/nullifier advisory lock, then use a fresh statement to look up `(poll_id, nullifier)` **before rejecting normal closure**:
   - Existing row and identical canonical answers: `200 {"status":"accepted"}`; no update and no count change, including after ordinary closure.
   - Existing row and different canonical answers: `409 credential_spent`; return no prior answers or response metadata.
   - No row: require the locked open/deadline check, then insert the nullifier and canonical answers together and commit before returning `201 {"status":"accepted"}`.
4. Enforce `PRIMARY KEY(poll_id, nullifier)`. For concurrent inserts, use conflict handling plus a fresh `READ COMMITTED` statement to reread the winner and apply the same equality rule. Identical concurrent submissions may both return success, but exactly **one row** is inserted. Different-answer races have one insertion and a conflict for the loser.
5. If no existing response and the poll is closed, return `410 poll_closed`; no new response is allowed even with a legitimate unused credential. If commit/HTTP outcome is uncertain, return a retryable error when possible; the client retries the same saved payload. Never assume an aborted connection means the transaction failed.

Credential verification is required before spent-status lookup/confirmation. Do not expose a separate nullifier-status endpoint, credential introspection API, or per-account participation endpoint. Confirmation is available while the response record/public key are retained; browser retry storage has the shorter limit in §8. Invalid or changed answers can return validation errors rather than confirming an earlier response.

## 11. Result publication contract

### Access and thresholds

Only the poll owner can access results. Before final closure return `409 results_not_closed`; return no count, text, intermediate aggregate, or progress percentage. Claim counts/status are never exposed through organiser features, even after closure; a participating organiser may receive only their own ordinary participant claim outcomes. Counts must not leak through generic poll/list endpoints, validation errors, dashboards, or frontend preload data.

After serialized final closure:

- If invalidated: `410 poll_withdrawn`, with no results.
- If accepted response count is below the poll's frozen `min_responses` (one for v2; five for existing v1): `200 {"state":"withheld","reason":"insufficient_responses"}`. Do not disclose a below-threshold count. Withholding is permanent; there is no reopen or override.
- Otherwise return a `ready` result containing `totalResponses` and one item per question in schema order. Each question is independently published only if at least the frozen `min_answers_per_question` responses contain a nonempty answer (one for v2; five for v1).
- A suppressed question returns only `{questionId, state:"withheld", reason:"insufficient_answers"}`. Do not send its precise answered/skipped counts, categories, mean, or texts. Required-question counts may be logically inferable from total responses; do not claim otherwise.

### Exact output and aggregation

Ready result shape is `{state:"ready", totalResponses, questions:[...]}`. A published question has `questionId`, `state:"published"`, `type`, `answeredCount`, and `skippedCount = totalResponses - answeredCount`, plus:

- `single_choice`: `options:[{optionId,count,percentage}]` in frozen option order. Include zero counts. Percentage denominator is `answeredCount`, rounded half-up to one decimal; totals may differ slightly from 100 due to rounding.
- `rating`: `distribution:[{value,count,percentage}]` for all integers 1–5 and `mean`, rounded half-up to two decimals. Mean/percentages exclude skipped answers.
- `free_text`: `texts:[string,...]`, one normalized nonempty text per answer, with duplicates preserved. No text edits, individual removals, sentiment enrichment, author fields, response IDs, or timestamps in MVP.

After the poll's frozen question threshold, exact category counts, including singletons, are deliberately allowed for useful low-stakes aggregates. No further cell suppression is claimed. A singleton category, unanimous answer, free-text content, repeated polls, or outside knowledge may permit inference. State this in organiser/participant guidance; do not describe the threshold as k-anonymity or differential privacy.

Generate an immutable result snapshot only after closure and eligibility for poll-level publication. Shuffle each published free-text question independently with cryptographically sourced randomness and persist only that shuffled text list in the snapshot. Do not reuse a cross-question permutation or derive presentation order from insertion order, nullifiers, or a shared response identifier. Independent random permutations can coincide by chance; tests must verify independent generation rather than demand that coincidence is impossible. Return the same snapshot on subsequent reads. Schema order applies to questions/options, not respondent text order.

Compute aggregates and snapshots on the server. Never send raw response objects to the portal and rely on hidden UI fields. The browser receives only the result DTO above plus the already-known question schema. No query parameter for filters, subgroups, date ranges, cross-tabs, or row exports is supported. The response service cannot read the organiser result snapshot.

## 12. Data model and database privilege boundaries

IDs are UUIDv4 unless stated otherwise. Identity-related and response-related tables live in separate database schemas. Poll ID is an intentional shared grouping key; there must be **no respondent-level linkage** between issuance and responses.

| Table | Required fields and constraints |
| --- | --- |
| `identity.users` | `id`, canonical `issuer`, `subject`, current verified normalized email, operator-managed organiser flag; unique `(issuer, subject)`. No cascading deletion of active claims. |
| `identity.sessions` | Hash of random session token, user ID, verified session identity attributes, CSRF secret, absolute expiry. No raw OAuth tokens. |
| `identity.oauth_transactions` | Hashed state/pre-auth binding, nonce, PKCE verifier, allowlisted portal return path, expiry; single-use and deleted on completion/expiry. |
| `polls` | `id`, owner ID, title, description, state, invalidation flag/reason, poll-level created/updated/opened/closed times, immutable deadline, question schema, frozen eligible count, policy version and thresholds, key ID; monotonic draft revision. These are poll-level, not respondent-level, timestamps. |
| `identity.eligibility` | `id`, `poll_id`, normalized email; unique `(poll_id,email)` and `(poll_id,id)` for the claim FK. No claim status in organiser DTOs. |
| `identity.claims` | `poll_id`, `user_id`, `eligibility_id`; unique `(poll_id,user_id)` and `(poll_id,eligibility_id)`; FK binds eligibility to the same poll. Row existence means consumed. No `claimed_at`, request body/hash, credential material, or response reference. |
| `signing_keys` | Unique key ID, unique poll ID, key version `1`, fixed suite, public JWK, unique public-key fingerprint, restricted private-secret reference and lifecycle state. Public views omit private references. |
| `anonymous.responses` | `poll_id`, 32-byte `nullifier`, canonical validated `answers`; primary key `(poll_id,nullifier)`. No user/eligibility/claim ID, raw credential/signature, response UUID/sequence, IP, user-agent, request ID, or response timestamp. |
| `anonymous.result_snapshots` | Unique poll ID, allowed immutable ready-result DTO only. No source row IDs, nullifiers, linkage arrays, or per-response timing. |
| `operations.purge_tombstones` | Poll ID and purge date, with no owner, email, question, answer, or credential data; retained for one year to enforce deletion during backup recovery. |

Use a deployment-only migration owner, never superuser credentials in an API. Revoke public/default table grants. Runtime permission design:

- Portal/admin code accesses owned poll configuration and supplied eligibility, not claim rows or raw responses. Ownership checks are server-side on every route and duplicated in privileged result functions.
- Issuance code may read verified identities/eligibility and perform the atomic claim operation; it cannot read response rows or result snapshots. Its route must not expose per-account claims to organisers. A separate issuer database role/pool enforces this boundary within the portal deployment.
- Public submission code sees only a public poll/key/schema view and a narrowly scoped redemption operation. It cannot read identity tables, private-key references, arbitrary response rows, or snapshots. The database redemption function compares canonical answers internally and returns only the defined outcome.
- Results code uses a reviewed, owner-gated database function/job to finalize closure and construct/read the allowed snapshot; it does not grant the portal unrestricted `SELECT` on responses. A privileged internal result-building role may read anonymous answer values only for this operation.
- Background closure/purge and deployment roles are separate from public request roles. `SECURITY DEFINER` functions, if used, have a fixed safe search path, explicit execute grants, no untrusted dynamic SQL, and enforce all relevant ownership/state checks.

Postgres does not require a response `created_at` column; do not add one. Transaction/WAL/backup internals may retain ordering/timing and are covered by the trusted-infrastructure limitation, not falsely described as erased by this schema. Claims/nullifiers must never be truncated or reset for a live poll.

## 13. API contract

All application endpoints below are under `/api/v1` on the indicated host. JSON responses use `Cache-Control: no-store`; errors have `{error:{code,message}}`, with optional field paths/row numbers but no echoed credential, answer text, email, or internal exception. Do not append global request-tracing IDs to participant payloads. Frontend routes `/p/:pollId` and `/claim-bridge` are separate from the API.

### Shared DTOs

- `DraftInput = {title,description,closesAt,questions,eligibilityEmails}` using the validated types/limits above. All fields are required; description may be empty. The browser parses pasted/CSV eligibility to the email array and the server independently validates it. There is no server file-upload endpoint.
- `OwnerPoll = {id,title,description,status,invalidated,createdAt,openedAt,closedAt,closesAt,revision,questions,eligibleCount,eligibilityEmails,eligibilityRetention,policy}`. Revision starts at `1`, increments on each successful draft update, and remains frozen on opening. After eligibility erasure, `eligibilityEmails:null` and `eligibilityRetention:"purged"`; otherwise `"retained"`. Contains no claims, response counts, response rows, or private-key references. `policy` is `{version:2,minEligible:1,minResponses:1,minAnswersPerQuestion:1}` for new polls and retains `{version:1,minEligible:10,minResponses:5,minAnswersPerQuestion:5}` for previously opened polls.
- `PublicPoll = {id,title,description,status,invalidated,openedAt,closedAt,closesAt,questions,policy,key}`. `key = {keyId,keyVersion:1,suite:"RSABSSA-SHA384-PSS-Randomized",modulusBits:3072,publicJwk}`. No owner identity, eligibility entries/count, claims, response counts, or result values. Drafts are not public; normal closed polls remain publicly readable until purge.
- Timestamps not yet applicable are `null`. `status`/`closedAt` reflect effective deadline closure. The implementation uses explicit DTO constructors, never serialization of database rows.

### Portal routes

| Method/path | Request and successful result | Permission/behavior |
| --- | --- | --- |
| `GET /auth/login` | Redirect to Google with bound state/nonce/PKCE. | Creates a short-lived portal pre-auth transaction; validated relative return path only. |
| `GET /auth/callback` | Validate code flow; redirect to clean portal page. | Single-use state/nonce checks, no query/body logs. |
| `GET /session` | `{user:{id,email,isOrganiser},csrfToken}`. | Own session only; `401` without one. Never called by response-origin code. |
| `POST /auth/logout` | Empty JSON request, `204`. | Session + CSRF. |
| `POST /polls` | `DraftInput` → `201 OwnerPoll`. | Organiser only. Server assigns owner/poll/key IDs and policy. |
| `GET /polls` | `{items:[summary,...],nextCursor:string\|null}`; maximum 50, ordered by `(createdAt,id)` descending; optional opaque cursor and `limit` 1–50 (default 20). | No response/claim counts. Summary is `OwnerPoll` without questions/eligibilityEmails; cursor is scoped to the authenticated owner; no arbitrary filter/sort. |
| `GET /polls/:id` | `200 OwnerPoll`. | Owner only. |
| `PUT /polls/:id` | `{revision,draft:DraftInput}` → `200 OwnerPoll`. | Owner + draft only; atomically replace validated draft, increment revision; stale revision `409 draft_conflict`. |
| `DELETE /polls/:id` | `204`. | Owner + draft only; delete draft data/key and write purge tombstone. Live/closed poll deletion follows retention/operator withdrawal, not this route. |
| `POST /polls/:id/open` | `{revision}` → `200 OwnerPoll`. | Owner; validates full draft/deadline/key, freezes policy/data. Already-open retry with that frozen revision returns the same state; closed poll `409 invalid_state`. |
| `POST /polls/:id/close` | `{}` → `200 OwnerPoll`. | Owner; already-closed retry is successful with no changes; draft `409 invalid_state`. |
| `GET /polls/:id/claim-context` | `200 PublicPoll`, identical public fields/parameters to the response host. | Any institutional session; bridge obtains poll/key without cross-origin API calls. No eligibility or claim-status fields; draft/unknown/purged `404`. |
| `POST /polls/:id/claim` | `{keyId,keyVersion:1,blindedMessage}` → `201 {blindSignature}`. | Verified eligible participant + CSRF; follows §9. No automatic retries. |
| `GET /polls/:id/results` | Withheld/ready DTO from §11. | Owner only, including authorization before threshold evaluation. |

Poll creation is not automatically retried after an uncertain response; refresh the owner's list to find the draft before creating another. Draft updates/open use revision checks to avoid lost edits. No patch endpoint, role-management endpoint, per-user participation endpoint, or eligibility mutation after opening exists.

### Response routes

| Method/path | Request and successful result | Behavior |
| --- | --- | --- |
| `GET /polls/:id/public` | `200 PublicPoll`. | Public knowledge of a UUID is sufficient to read non-draft metadata; no authentication or eligibility claim implied. |
| `POST /polls/:id/responses` | `{credential,answers}` → `201` for insertion or `200` for identical replay; body `{status:"accepted"}`. | §10; no cookies/login; no response ID, nullifier, timestamp, answer echo, or eligibility data returned. |

CORS is disabled on both hosts. Portal mutations require their exact browser origin. Response mutations accept their exact origin, or an absent Origin for non-browser clients; reject other browser origins. These checks are defense in depth, not anonymous authentication—only the credential authorizes redemption. Do not proxy arbitrary URLs or support JSONP.

### Error/status mapping

- `400 invalid_request`: malformed JSON/encoding, unknown fields/version, or invalid input framing; `400 invalid_credential`: generic credential failure.
- `401 authentication_required`: absent/expired portal session. `403 forbidden`/`csrf_failed`: invalid role, institutional identity, origin, or CSRF. An authenticated claim may return generic `403 not_eligible`; no list membership for other addresses is revealed.
- `404 not_found`: unknown, draft-public, purged, or non-owned resource as appropriate.
- `409 claim_consumed`, `credential_spent`, `draft_conflict`, `invalid_state`, or `results_not_closed` as defined above.
- `410 poll_closed` for a new claim/submission after closure; `410 poll_withdrawn` for invalidation. Existing valid response retries follow §10 instead of ordinary closure rejection.
- `413 payload_too_large`; `415 unsupported_media_type`; `422 validation_failed` for semantic poll/answer errors. An invalid answer never consumes a credential.
- `429 rate_limited` with integer `Retry-After`; `503 capacity_unavailable` before work/claim consumption; `503 claim_consumed_no_credential` after known claim consumption; otherwise `503 temporarily_unavailable` with explicit uncertainty handling.
- Unexpected errors use `500 internal_error`, without stack traces/body dumps. Claim failures after a durable commit must preserve the consumed state regardless of status/connection loss.

Apply state/authorization checks consistently: no publishing details to non-owners and no alternate endpoint that bypasses publication or claim policy. Detailed bad-field paths are allowed for the caller's own input, never stored prior answers or private eligibility data.

## 14. Frontend, network, and resource security

### Content and browser headers

All organiser/participant content is untrusted and rendered as escaped plain text. Do not use `dangerouslySetInnerHTML`, automatic Markdown/HTML renderers, remote images, remote fonts, third-party frontend scripts, analytics, advertising, session replay, or CAPTCHA. No service worker stores credentials, API responses, or form bodies. Disable prefetch/prerender of authentication/claim routes and automatic claim/submission fetch retries.

Production CSP baseline: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; worker-src 'self'; base-uri 'none'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'self'`. No inline/eval exceptions in production. Bundle scripts/styles locally. Auth uses top-level server redirects, not embedded Google frames. Apply `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and a Permissions Policy disabling camera, microphone, and geolocation. Enable HSTS after TLS/hostname validation. Preserve the intentional bridge COOP exception in §8.

Serve HTML/API/auth responses with `Cache-Control: no-store`; content-hashed static JS/CSS may be cached without user-specific variation. Do not put personal or credential information in asset names, ETags, cache keys, CSP-report URLs, referrers, or links. No CSP reporting endpoint captures original request URLs/bodies by default.

The response host must never set cookies. Its ingress strips `Cookie`, `Authorization`, identity-proxy headers, client-IP forwarding headers (`Forwarded`, `X-Forwarded-For`, `True-Client-IP`, and provider equivalents), `User-Agent`/client-hint headers, incoming trace/baggage headers, and cross-service request IDs before the submission application, without logging them. Normal browser tests must confirm no portal auth cookie is sent on response navigation, assets, or API requests. A manually forged client can send arbitrary headers to an edge; the promise is that these are not required, used, forwarded to the response app, or retained.

### Request bounds and abuse controls

Enforce limits at ingress and application, before expensive parsing/crypto. Reject compressed request bodies; JSON only except the documented OAuth callback. Defaults are part of MVP deployment configuration and may be lowered for capacity, not silently raised without load/security tests:

| Limit | Value |
| --- | --- |
| Draft/create/update JSON | 256 KiB body; 1,000 eligible entries; 20 questions. |
| Claim JSON | 2 KiB body; exact 384-byte blinded input. |
| Response JSON | 64 KiB body; exact credential lengths; answer limits from §7. |
| Headers / URI | 8 KiB aggregate headers / 2 KiB URI; no secret-bearing query parameters. |
| Public reads | In-memory global token bucket: 100 requests/s, burst 200. |
| Public submissions | Global 20/s, burst 40; per poll 5/s, burst 10; four concurrent signature verifications, maximum 20 queued, maximum two-second queue wait. |
| Claims | Five attempts/minute per authenticated account; two concurrent native sign operations, at most ten waiting, maximum two-second wait before reservation/claim consumption. |
| Draft/key creation | Ten/day per organiser, maximum 50 retained polls per organiser; two concurrent key generations. |
| Timeouts | Five seconds to receive a body; ten-second application request budget; two-second DB lock/transaction budget; bounded native signer timeout within the remaining request budget. |

Public-side buckets are keyed only by service/route class or public poll ID, never IP, user-agent, fingerprint, cookie, device ID, credential, or nullifier. Keep counters in memory, expire idle per-poll entries within ten minutes, and do not log individual admission decisions. Account-keyed limits are allowed only on the authenticated portal. For MVP deploy one active request-admission instance per service so limits are not accidentally multiplied; scaling requires a reviewed privacy-compatible shared limiter.

These controls do not guarantee availability against a distributed attack. Under overload fail closed and return bounded errors; do not introduce persistent IP tracking or external CAPTCHA as an unnoticed “quick fix”. Rate limits are not uniqueness enforcement. Database constraints remain authoritative.

## 15. Logging, retention, deletion, and operations

### Logging and observability

Disable request-level access logs on the entire response origin: HTML, assets, public metadata, successful submissions, rejected submissions, and exceptions, including ingress/CDN/WAF/load balancer/application layers. For portal auth/bridge/claim routes, disable identity/body/query/request-level tracing as well. No analytics or cross-origin correlation IDs.

Never log credentials, secrets, signatures (blind or unblinded), answers, allowlist contents, session/CSRF tokens, OAuth codes/tokens, raw request bodies, IPs, user-agents, or participant-level claim events. Configure database error/statement logging, crash reporters, profiling, core dumps, swap, and native signer diagnostics so they cannot retain request bodies or key material. Disable core dumps and unencrypted swap. Do not rely on application redaction while leaving proxy or APM capture enabled.

Operational metrics may contain coarse service-wide hourly totals, latency histograms, and generic error categories with no poll/account/credential labels, raw samples, or request exemplars. Retain these for at most 30 days. Poll-level administrative open/close/withdrawal/configuration events are allowed; participant issuance/redemption events are not. No exact per-response timestamps in the application schema or logging layer.

Database WAL, storage ordering, encrypted backups, transient network processing, and the identity provider may still carry operational timing/metadata. Operators and infrastructure are trusted not to correlate them. Do not promise that a relational database removes every possible timing trace. Real hosting that cannot meet the application/edge logging policy is not approved for real participants.

### Retention schedule

Run data-expiry jobs at least hourly, using the effective closure time even if scheduler materialization was delayed. Access expires at the specified boundary independently of physical deletion: eligibility DTOs become purged after seven days, and expired poll/content/result/confirmation endpoints return `404` after 90 days even if cleanup is delayed. Physical deletion must complete within one hour of the boundary; include that processing allowance in retention notices, followed by the backup-expiry allowance below. OAuth transactions have the shorter cleanup schedule below. All deletions are access-controlled and tested; live claims/nullifiers may not be deleted individually.

| Data | Retention/action |
| --- | --- |
| OAuth transactions | Valid for ten minutes maximum; single-use deletion on completion. Expired rows/pre-auth state are removed within one further minute by a dedicated cleanup task. |
| Portal sessions | Eight hours maximum; invalidate on logout; expired rows removed within one hour. |
| Unopened drafts and their keys | Delete after 30 days without a draft edit; owner can delete earlier. |
| Live poll eligibility/claims/key | Keep intact through closure. No entitlement resets, user deletion cascades, or nullifier cleanup while live. |
| Closed-poll eligibility and claims | Delete from live storage seven days after closure, including for withheld/withdrawn polls; owner UI then shows eligibility as purged. |
| Private signing key | Mark for destruction at closure and delete on the next hourly cleanup, with a hard 24-hour maximum even during operational delays. No recovery/rotation to reopen. |
| Responses, result snapshots, question/content data, public keys, and closed poll owner association | Delete from live storage 90 days after closure, regardless of whether results were viewed or withheld. Replace with minimal purge tombstone. |
| User identity | Delete non-organiser accounts when no retained claim/session/owned poll requires them, via the hourly job. Organiser identities remain only while their role or retained polls require them. |
| Purge tombstones | One year; poll ID and purge date only. |
| Encrypted backups/WAL archives | Rolling seven-day maximum; no indefinite snapshots, log exports, or copied production fixtures. |
| Browser state | §8; local deletion is best effort when the app runs, not a remote wipe guarantee. |

A deletion from live storage may remain in encrypted backups for up to seven additional days. Communicate that qualification. Backup keys/access are restricted separately; never copy production identity/answer/key data into local demos. Account erasure requests are handled by the operator, not a public endpoint that can reset a live entitlement. Organisers cannot selectively erase individual text answers or responses to change results.

### Durability, restoration, and incidents

- Use durable PostgreSQL commits and durable private-key storage; successful API responses are sent only after relevant commits. Do not run the real deployment on ephemeral database/key volumes.
- Database and encrypted key backups must support consistent recovery, but a backup is not permission to resume polling. Keep ingress disabled throughout restoration.
- Mirror poll purge and withdrawal decisions to a protected append-only recovery journal outside the database's rollback domain. Journal entries contain only event kind, poll ID, coarse reason, and event time; no identities, answers, or credential material. Keep them for one year and acknowledge deletion/withdrawal only after the journal and live state are durable. This prevents restoring an older backup from resurrecting a deleted draft or previously withdrawn closed poll. If the authoritative journal is missing/incomplete, keep the recovery offline or start a new empty deployment; do not guess that recovered data is publishable.
- Before any restored deployment accepts traffic, replay that journal, apply retained purge tombstones and expired-data deletions, invalidate **every restored poll that was open in the recovered database**, close it permanently, and destroy/disable its signing key. A rollback may have forgotten claims or nullifiers; never attempt to infer that a restored open poll is safe to resume.
- Closed polls from a transactionally consistent backup may remain readable only after verifying closure consistency, retention, and absence of an integrity incident. When uncertain, withdraw them as well. Document lost data honestly.
- Any suspected key compromise, unexpectedly missing active/draft key, inconsistent response/claim state, unsafe logging, or privacy-policy bypass pauses the affected service and withdraws affected live polls. An intentionally destroyed closed-poll private key is not a missing-key incident. No ad hoc key regeneration, claim reset, or threshold lowering.
- Notify organisers and, where possible, the whole eligible group or public poll audience; never identify or message only claimed/responded users. Logging/privacy incidents may require withdrawing additional polls even if their signature integrity is intact.
- Emergency withdrawal and recovery are operator-only, poll-level audited actions. This does not give organisers raw database access or introduce delegated roles.

## 16. Environment and deployment contract

Required production configuration includes exact portal/response HTTPS origins, fixed Google OAuth client ID/secret/callback, email domain and hosted domain above, database role credentials, private-key secret-store path, private signer endpoint/service credential, and retention/limiter settings. No credential or signing secret belongs in Vite public environment variables.

Production startup fails closed for: identical portal/response hostname, HTTP origins, wildcard origins/callbacks, missing institutional `hd` validation, demo authentication, missing signer/native-RSA capability, unavailable durable storage, missing DB isolation, or publication settings outside the two supported frozen policy versions. The deployment checklist must separately attest proxy/hosting logging configuration; this cannot be proven merely by an application flag.

Use a dedicated local/demo executable with synthetic accounts and isolated database/keys, bound to loopback only. The production artifact excludes the mock identity provider and seeded-login routes; production configuration rejects any demo-auth switch. Demo accounts use stable synthetic subjects and are not real Google tokens. Keep the same versioned policies in demos and production; there is no demo-only threshold shortcut.

The initial production institutional/OAuth assumptions must be confirmed with real IITGN accounts and the institution's Google configuration. If IITGN cannot authorize the configured app or the signed domain claims differ, do not weaken verification. Ship only the clearly labelled local synthetic demo until the deployment facts are resolved and the configuration/spec is reviewed. Two approved HTTPS hostnames and logging-compliant infrastructure are similarly mandatory release prerequisites.

## 17. Acceptance tests and evidence

Use unit tests for encodings/validation, integration tests against real PostgreSQL for constraints/transactions/roles, and Playwright tests on both HTTPS hostnames in supported browsers. Do not substitute an in-memory database for concurrency/locking tests. Security tests inspect network traffic and persisted data, not only visible UI. Passing vectors is evidence of interoperability, not proof of implementation security or anonymity.

### Identity and authorisation

1. Valid institutional Google identity can establish a portal session; invalid signature/issuer/audience/expiry/nonce, missing/wrong `hd`, unverified email, non-institutional email, login-CSRF, reused state, and unsafe return paths fail.
2. `(issuer,sub)` maps consistently across logins/email changes. Alternate listed addresses do not allow a second claim; email reassignment cannot consume an already-used eligibility entry.
3. Non-organisers cannot create/manage polls; organiser A cannot read/edit/open/close/delete/view results for organiser B's poll, including guessed IDs and mass-assignment fields.
4. CSRF and origin protections cover claim, create, update, open, close, delete, and logout. A stolen/forwarded invitation alone cannot obtain a credential. Production builds cannot enable mock login or relaxed policy.

### Crypto and issuance

5. RFC 9474 suite vectors, §7 encoding/nullifier fixture, native signer fault/input tests, and Chromium/Firefox-to-server interoperability pass. Verify preparation prefix retention and finalization after restoring a usable credential from IndexedDB.
6. Use unique keys for polls A and B. A client eligible only for A blinds a message containing B's poll ID, claims through A, and attempts redemption in B: it fails. This test constructs the hidden B message before signing, not just by tampering afterward. Cross-environment keys also fail.
7. Tampered signatures/messages, wrong key/version/poll/tag, noncanonical base64url/UUIDs, bad lengths/ranges, and malformed answers fail without storing raw input or consuming a response entitlement.
8. Concurrent claims from the same account or the same eligibility entry yield at most one released credential. Inject failure before insertion, during commit, after commit, during native signing, and after signature delivery; verify durable fail-closed behavior and no premature signature release.
9. Draft, closed, expired, and withdrawn polls cannot issue new credentials. Process restarts retain existing keys; missing keys do not cause regeneration.

### Redemption and lifecycle

10. A valid credential inserts one response. Concurrent identical requests create one row and may both report accepted; concurrent different answers create one row and a conflict. Alternate preparation/signature material for the same poll/secret has the same nullifier.
11. Invalid/missing/unknown answers fail without spending a credential. Normalization and reordered answers produce the expected idempotency behavior; changed answers cannot replace the first response.
12. Lose the HTTP acknowledgment after a committed insert; retry the saved payload successfully, including after normal closure. Also retry just after the deadline while an earlier admitted insertion is uncommitted: it waits for that outcome or returns a retryable timeout, never a premature terminal “closed”. Unknown commit outcomes never create a second row. No prior answer data is returned for conflicts.
13. Exercise claim/submit versus manual close, deadline, invalidation, and result publication with barriers inside real transactions. Closing waits for admitted work; after closure no new insertion is possible; publication sees the stable final set. Verify deadline enforcement with the closure scheduler stopped.
14. Draft revision conflicts and open-versus-edit races cannot mutate frozen content, eligibility, deadlines, keys, or policies. Closed polls never reopen, including by direct runtime-role SQL permissions.

### Browser and privacy

15. Check that portal cookies are absent from response navigation/assets/API requests and that response functionality requires no login cookie. Distinct-port/same-host configuration must fail the isolation preflight.
16. Spoof bridge origin/source/nonce/type/poll/key, visit it directly, replay messages, block popups, expire the session, reload/close each tab mid-claim, use concurrent tabs, deny IndexedDB/Web Locks, and simulate write/read-back failure. No usable credential or identity crosses the wrong origin; no accidental second claim is attempted.
17. Inspect storage across prepared/usable/pending/terminal states, successful deletion, closure cleanup, expired pending confirmation, and next-launch sweep. Credential state never appears in URLs, history, clipboard handoff, shared cookies, or analytics.
18. Inject malicious HTML/scripts/images/URLs into every organiser and free-text field. They render as inert text, make no external requests, and cannot steal a credential/session. Test CSP and opener behavior in real builds.
19. Inspect PostgreSQL tables, result snapshots, normal/error/rejection logs, native signer diagnostics, proxy/CDN/WAF configuration, and tracing. Verify no respondent-level identity join, credential/signature/body retention, participant request IDs, response timestamps, or identity metadata in response persistence. Poll ID joins are expected and permitted.
20. Verify runtime DB roles cannot read forbidden tables or bypass ownership/publication via functions, search-path injection, views, or direct SQL.

### Publication, operations, and demo

21. Test new polls at zero/one responses and zero/one nonempty answers; verify that existing v1 polls retain their frozen five/five thresholds. Blank optional text does not count; no all-empty submission is valid. Below-threshold DTOs omit exact counts/values. No owner route/preload leaks open counts or results.
22. Verify count/percentage/mean denominators, rounding, zeros, skipped answers, duplicate texts, independent stable per-question shuffling, and absence of response-level grouping in actual JSON. Free text is off by default and never required.
23. Verify immutable privacy policy, no export/filter bypass, permanent withheld state, emergency withdrawal, and that cached snapshots are inaccessible after withdrawal/purge.
24. Test request limits, bounded concurrency/timeouts, and overload before claim consumption. Public rate-limit storage has no participant/IP/device keys and expires as specified.
25. Advance clocks to each retention boundary; check sessions, claims, eligibility, keys, responses, snapshots, users, tombstones, browser cleanup, and backup-expiry procedures. Verify no live uniqueness state is removed by account deletion or cleanup.
26. Restore a stale backup and simulate key loss/compromise. Traffic remains disabled until restored open polls are withdrawn and the independent purge/withdrawal journal is replayed; deleted drafts and previously withdrawn closed polls cannot reappear. A credential/claim forgotten by rollback cannot become usable in a resumed poll.
27. Local walkthrough: ten synthetic eligible accounts plus an ineligible account, owner creates/previews/opens a poll, five different eligible accounts claim and submit, duplicate/ineligible/tampered attempts fail or idempotently confirm as appropriate, close, then display aggregates and a qualifying text list. Demonstrate a separate four-response poll that remains withheld. No privileged “show results anyway” demo route.

## 18. Build sequence and release gates

### Phase 0 — feasibility and boundary proof

Create the two HTTPS development origins and production deployment plan; verify cookie isolation and browser popup behavior. Validate the pinned RSABSSA suite/library with the chosen native signer/runtime, exact encoding, test vectors, and browser/server round trips. Review the server private-operation implementation and key-storage path. Configure Google OIDC and inspect actual signed IITGN domain claims where access is available. Inventory and disable unsafe logs across every proposed deployment layer.

**Exit evidence:** recorded dependency/runtime pins and integrity, test output, native-RSA path confirmation, origin/network captures, and a hosting/logging checklist. Real-account/OAuth/hosting evidence may remain a release prerequisite while work proceeds using the isolated synthetic demo. No claim that these checks already passed is permitted.

If browser/native crypto cannot meet this contract, halt the credential implementation and revise the spec explicitly. Do not replace blind signatures with ordinary tokens or quietly change the key scheme.

### Phase 1 — secure vertical skeleton

Set up separate API/DB roles, migrations, server-side authentication/CSRF, owner authorization, draft schema/import/preview, key provisioning, state-machine locking, immutable policy, public DTOs, and both browser entry points. Add privacy-safe logging and result-denial tests from the outset. Do not postpone origin isolation or threshold enforcement as polish.

### Phase 2 — core protocol and failure handling

Implement exact credential encoding, durable claim reservation, native signing, response-origin storage/bridge, canonical answers, transactional redemption, idempotent confirmation, and cleanup. Run concurrency, cross-poll, crash, hostile-message, XSS, and network/logging tests before adding presentation features.

### Phase 3 — publication and operational readiness

Implement finalization/snapshots, per-question suppression, independent text ordering, retention/backup/recovery/withdrawal, bounds/load tests, complete error/uncertainty UX, and the synthetic walkthrough. Run all acceptance tests against the production-like topology.

### Real-participant release gate

Release requires all acceptance tests plus verified institutional OAuth/domain configuration, supported-browser interoperation, correct native signing, durable private keys/database, two HTTPS hostnames, production mock-auth exclusion, approved logging/backup settings, and an exercised recovery/withdrawal procedure. If external institutional or infrastructure approval is unavailable, the deliverable remains a labelled local demo; no user-facing anonymity or eligibility claim is based on an unverified deployment assumption.

## 19. Normative references and implementation notes

- RFC 9474, particularly preparation/verification, suite selection, key separation, and security considerations: https://www.rfc-editor.org/rfc/rfc9474
- Selected library and upstream source/API documentation: https://github.com/cloudflare/blindrsa-ts ; package pin `@cloudflare/blindrsa-ts@0.4.6`. Check the actual pinned API option spelling (`supportsRSARAW`) rather than copying an outdated example.
- Google ID-token verification and institutional `hd` guidance: https://developers.google.com/identity/gsi/web/guides/verify-google-id-token
- Cookie host/port limitations: RFC 6265 §8.5, https://www.rfc-editor.org/rfc/rfc6265#section-8.5

This specification deliberately trades recoverability, broad browser support, and sophisticated analytics for a smaller, testable low-stakes privacy boundary. Passing its tests does not turn the product into a mathematically anonymous or publicly verifiable election system.
