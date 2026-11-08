# Diagrams

Editable draw.io sources for explaining the system and its privacy model. Open them in draw.io desktop, the VS Code "Draw.io Integration" extension, or app.diagrams.net (File → Open from → Device; the file stays in your browser).

**These diagrams describe the design specified in [`SPEC.md`](../../SPEC.md). They are not evidence that an implementation meets it.** See [`PLAN.md`](../../PLAN.md) for what has been built and tested. If a diagram and the spec disagree, the spec wins and the diagram is wrong.

Colours follow the Feedback Booth palette ([`design/tokens.css`](../../design/tokens.css)):

| Colour | Meaning |
| --- | --- |
| Amber | Identity side: knows who you are (portal, issuer, signer, `identity.*`) |
| Blue | Anonymous side: sees answers, not people (response tab, response API, `anonymous.*`) |
| White | Your browser |
| Grey | Shared infrastructure that must be trusted; dashed means external or isolated |
| Red dashed | A link that must not exist |

## Files

| File | For | Shows |
| --- | --- | --- |
| `system-architecture.drawio` | Engineers, reviewers | Components, the two HTTPS origins, trust boundaries, database schemas, and what crosses each boundary. |
| `blind-credential-flow.drawio` | Engineers, technical judges | Step-by-step credential issuance and redemption, with notes on what each party can and cannot see. |
| `blind-credential-flow.seq.json` | Maintainers | Source for the sequence diagram's geometry (see Editing). |
| `who-sees-what.drawio` | Participants, organisers | The envelope analogy, what each side knows, what organisers see, and what users still have to trust. |
| `credential-states.drawio` | Frontend engineers (Milestones 3–4) | Browser credential states (`prepared` → `claim_sent` → `usable` → `submit_pending` → final), retries, final states and cleanup rules. |
| `poll-lifecycle.drawio` | Backend engineers, reviewers | draft → open → closed, deletion, operator withdrawal and purge; what freezes at opening; lock order and timing. |
| `results-gate.drawio` | Everyone who asks "why can't I see results?" | Owner, closure, withdrawal, response and per-question thresholds, the stored snapshot, and what results never include. |
| `data-access.drawio` | Backend engineers, reviewers | What each runtime database role can and cannot touch, the four data stores, and the database rules. |
| `threat-model.drawio` | Judges, reviewers, institution | What the design prevents, what it only reduces, what is out of scope or trusted, and the release gate. |

## What the diagrams claim, and where the spec says so

| Claim | SPEC.md |
| --- | --- |
| At most one credential per institutional account (and per allowlist entry) per poll. Not one per human. | §1 (1), §5, §9 |
| A fresh RSA-3072 key per poll; RFC 9474 `RSABSSA-SHA384-PSS-Randomized`; no shared or rotated keys. | §1 (4), §6 |
| The response origin alone makes the secret, blinds, unblinds and stores the credential. The portal sees only the poll/key IDs, the blinded request and the blind signature. | §7, §8 |
| The bridge is `postMessage` between exact origins, with a fresh nonce per connection. Credentials never go in URLs, cookies, server storage or the clipboard. | §5, §8 |
| A claim is committed before signing; claim rows hold only (poll, user, eligibility entry). | §9, §12 |
| The signer is loopback-only with no database access; private keys live on an encrypted volume, not in Postgres, and are destroyed within 24 h of closing. | §6, §15 |
| Submission needs no sign-in and sends no cookies. The nullifier makes a credential usable once; an identical retry confirms, different answers are refused. | §7, §10 |
| Response rows hold no account, IP, user-agent, request ID or timestamp. Ingress strips identifying headers; the response origin keeps no access logs. | §12, §14, §15 |
| Results only after closing, only to the owner, only with ≥ 5 responses (and ≥ 5 answers per question); free text shuffled; no live counts. | §1 (5), §11 |
| The operator and infrastructure are trusted; a dishonest issuer could mint extra credentials. Free text, small categories, outside knowledge and network metadata can still identify people. Not an election system. | §1 (6), §2, §3 |
| The browser never starts a second claim on its own; uncertain submissions retry the exact saved payload; secrets are erased on success, closure or expiry. | §8 |
| Closed is final; content, eligibility, deadline, policy and key freeze at opening; deadlines use the database clock; one lock order everywhere. | §4 |
| Each service has its own database role with only the access listed in `data-access.drawio`; no public grants and no superuser in an API. | §12 |
| Real participants only after the §18 release gates; until then, a labelled local demo. | §16, §18 |

## Editing

- Diagrams were checked with the draw.io skill's `validate.py --score` (0 errors, 0 crossings, 0 overlaps) and by rendering them in the diagrams.net viewer.
- `blind-credential-flow.drawio` was generated from `blind-credential-flow.seq.json` with the skill's `seqlayout.py`, then given wider lifeline headers, the dark palette, the title and the phase bands. For small wording changes, edit the `.drawio` directly. If the flow itself changes, edit the JSON and regenerate, rather than moving arrows by hand.
- Keep labels plain and accurate. Do not add "100% anonymous" or any claim the spec does not make.

## Exporting

Rendered PDFs of every diagram are in [`pdf/`](pdf/), one page each, cropped to the diagram. They are generated from the `.drawio` sources, so re-export after editing a diagram. With draw.io desktop installed, from this folder:

```sh
for f in *.drawio; do drawio -x -f pdf --crop -o "pdf/${f%.drawio}.pdf" "$f"; done
```

Other formats:

```sh
drawio -x -f svg -e -o system-architecture.svg system-architecture.drawio   # -e keeps the diagram editable inside the SVG
drawio -x -f png -e -s 2 -o who-sees-what.png who-sees-what.drawio
```

## Keeping them true

When `SPEC.md` changes, or an implementation milestone settles a detail (for example the real database roles in Milestone 2 or 6), update the matching diagram and its row in the claims table above. `data-access.drawio` in particular records the roles the spec describes; check it against the actual grants once they exist.
