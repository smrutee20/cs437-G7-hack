# Design: Feedback Booth

**Status: implemented.** The components and machines below live in [`packages/ui`](../packages/ui) and are used by both apps (Milestone 6, slice 4 in [`PLAN.md`](../PLAN.md)). This folder remains the reference: [`SPEC.md`](../SPEC.md) controls wherever this document and the spec differ.

Interactive mockups: the "Feedback Booth Design" canvas on claude.ai (private to its owner; share it from the page's Share menu). The canvas sources are in [`mockups/`](mockups/).

## Files

| Path | What it is |
| --- | --- |
| `tokens.css` | Colour, type, shape, and motion tokens as CSS custom properties. |
| `illustrations/booth.svg` | Response-site machine, idle state. Opens directly in a browser. |
| `illustrations/press-404.svg` | Portal stamp press stamping "404" onto a card (animated loop). |
| `mockups/*.dc.html` | Canvas sources for the four boards (response site, 404, results, design system). They need the canvas runtime (`support.js`) and do not render standalone; read them for layout, copy, and state logic. Mockup data is synthetic. |
| `tools/iso.py` | Isometric geometry helper: box polygons, face matrices, dot-matrix circles. `python3 design/tools/iso.py --help`. |

## Concept: the carbon-lined envelope

Blind signatures (SPEC.md §1, §6) are usually explained with Chaum's analogy: you seal a slip in a carbon-lined envelope, the official stamps the outside, and the stamp transfers to the slip without the official seeing it. The UI makes that literal. Machines are the status indicators and the privacy explanation at the same time.

| Browser state (SPEC.md §8) | What the user sees |
| --- | --- |
| no local state | Booth idle; display counts down to the deadline (`6D 08H`, dim). Empty ledge. |
| `prepared` | A sealed envelope sits on the booth ledge. Display `SEALED`. |
| `claim_sent` (bridge open) | Ledge empty, booth LEDs chase, display `WAIT`. The portal popup shows the signed-in account and the press. |
| bridge confirmation → blind signature | Press head stamps the envelope; envelope slides out; stamp mark lights. |
| `usable` | Booth ledge holds the stamped card, stamp lit, display `READY` (lit). |
| `submit_pending` | Card slides into the booth slot, LEDs chase, display `SEND`. Answers frozen. |
| `accepted` (terminal) | Ledge empty, LEDs lit, display `THANKS`. No receipt, no number. |
| `spent` / `claim_uncertain` | Card punched through / envelope with a `?` (not yet drawn). |
| results withheld | Dim `WITHHELD` display; no numbers anywhere. |

## Two origins, one family

People must always know which window knows who they are.

- **Portal ("Issuing desk")**: header shows an ID-badge chip with the signed-in email. Hero object: the stamp press. The claim-bridge popup (~440 px wide) puts the badge next to the poll title above "Stamp my envelope".
- **Response site ("Booth")**: header chip reads "No sign-in on this site". Hero object: the booth, in a panel beside the questions that shows credential state and holds the one primary button.

Same tokens on both hosts; each app bundles its own copy of the assets.

## Rules the design must keep (from SPEC.md)

- **CSP (§14)**: `style-src 'self'`, `img-src 'self'`, `font-src 'self'`, no inline exceptions.
  - No CSS-in-JS libraries that inject `<style>` tags. Use CSS Modules plus `tokens.css`.
  - No `data:` URIs: set `build.assetsInlineLimit: 0` in both Vite configs, or Vite inlines small SVGs/fonts and the browser blocks them.
  - Illustrations become React SVG components, never `innerHTML`/`dangerouslySetInnerHTML`. The standalone SVGs here use an internal `<style>` for convenience; in the app that CSS moves to a CSS module.
  - Fonts are self-hosted woff2 files in each bundle. The mockups load Geist from Google Fonts only for preview.
  - Vite's dev server injects styles differently, so check animations under `vite preview` with the production CSP.
- **No counts before closure (§11)**: no response counters, progress bars, or anything on organiser screens that changes as responses arrive. An open poll shows only its state and deadline.
- **No receipts (§3)**: the success screen never looks like a ticket and never shows an ID.
- **Honest anonymity (§3)**: no "100% anonymous", masks, or shields. Never imply the organiser cannot infer anything from answer content.
- **Mandatory wording (§3)**: the privacy notice is shown verbatim in a notice plate. The credential-loss warning appears before claiming. The identification warning sits beside every free-text field and again before submitting.
- **User content is plain text (§7)** and can be long (title 120, prompt 500, description 2,000 code points). Layouts wrap; nothing truncates meaning. **Dot-matrix displays show system states and numbers only, never user-written text.**
- **Irreversible actions** (claim, open, close): the machine animation plays after the explicit confirmation, never as the confirmation. "Open claim window" calls `window.open` synchronously in the click handler (§8); no animation runs before the popup opens.
- **Supported browsers (§2)**: desktop Chromium and Firefox. Design desktop-first, plus the compact bridge popup.

## Tokens and type

See [`tokens.css`](tokens.css). The essentials:

- Near-black ground `#111111`, surfaces `#141414`, 1 px borders `#2a2a2a`.
- Text `#f2f2f2`; muted `#a3a3a3` (7.5:1); quiet `#8f8f8f` (5.7:1 on surfaces).
- **One action colour**: blue `#2563eb` pill buttons with a soft glow (white text 5.2:1).
- Amber `#f0b14a` only for disclosure plates; red `#dc2626` only for irreversible organiser actions.
- **Light means something real happened**: success, verification, and publication are shown by lit white dots, never green.
- Type: Geist for everything, Geist Mono for timestamps and question numbers.

## Components (planned for the shared UI package)

| Component | Purpose | Notes |
| --- | --- | --- |
| `DotDisplay` | 5×7 dot glyphs with off / dim / lit states. | Effects: scramble-then-settle (≈8 frames at 55 ms, settling left to right), sweep-on via per-dot `transition-delay`. Always has an accessible label with the real text. |
| `StatusPlate` | Small `DotDisplay` for DRAFT / OPEN / CLOSED / WITHDRAWN. | Open is lit; other states dim. |
| `Booth`, `Press`, `Vault` | Isometric machine illustrations with named animatable parts. | `role="img"` with a state-aware label; decorative overlays `aria-hidden`. |
| `MarqueeLights` | LED chase that replaces every spinner. | Runs only while waiting on something. |
| `NoticePlate` | Engraved-looking panel (corner screws) for mandatory wording. | Full-contrast 15 px text. |
| `WarningPlate` | Amber disclosure panel with icon. | Loss and identification warnings. |
| `Button` | Primary (blue pill), secondary (outline), danger (red), disabled. | 46–50 px tall; visible 2 px focus ring. |
| `RatingKeys` | Five dot-matrix numeral keys that light when selected. | Radio-group semantics, keyboard operable. |
| `ChoiceList` | Option cards with a lit radio dot. | Optional questions can be cleared. |
| `StepList` | Three credential steps: done (lit), current (blue ring), to do (outline). | Inside the booth panel. |
| `DotBars`, `DotColumns` | Result charts made of dots. | Exact count and percentage always shown as text; charts are `aria-hidden`. |
| `WithheldPlate` | Dim `WITHHELD` display with the reason. | Contains no numbers. |

## Isometric illustrations

- Projection: `sx = ox + (x − y)·cos30`, `sy = oy + (x + y)·sin30 − z`. 1 px strokes `#555555`; faces filled top `#1c1c1c`, front `#151515`, side `#111111`.
- Flat artwork goes onto a face with a matrix (face-local u right, w down). Front: `matrix(0.866 0.5 0 1 Px Py)`. Side: `matrix(0.866 -0.5 0 1 Px Py)`. Top: `matrix(0.866 0.5 -0.866 0.5 Px Py)`. `tools/iso.py` prints the polygons and the `Px Py` origins.
- Strokes inside a matrix group need `vector-effect: non-scaling-stroke`.
- A CSS `transform` replaces an SVG element's `transform` attribute, so animate a wrapper `<g>` around the positioned group. For rotations (the press lever), translate a wrapper to the pivot and rotate an inner group about its origin.
- An HTML `DotDisplay` can sit on a machine face using the same matrix as a CSS transform (`transform-origin: 0 0`). The booth's display does this.

## Motion

- 150–250 ms for UI feedback; 0.6–1.2 s for machine moments; the bridge stamp is a 2.4 s one-shot.
- Loop only while waiting (LED chase). Idle machines stay still.
- Nothing moves in a way that suggests live counts or progress toward results.
- `prefers-reduced-motion`: jump to the final state (no scramble, chase, or slide).
- CSS keyframes and the Web Animations API change styles through CSSOM, which `style-src 'self'` allows (confirm in the Playwright CSP tests).

## Screens and when they land

The build order follows [`PLAN.md`](../PLAN.md): working, plain screens first; machine animations after that flow's protocol and security tests pass (SPEC.md §18).

| Screen | Hero moment | Milestone |
| --- | --- | --- |
| Organiser poll list, editor, eligibility import, preview, open, close | Status plates; after the confirmation dialog the machine locks and DRAFT flips to OPEN | 2 |
| Response poll page + booth panel; claim-bridge popup | Countdown display; press stamps the envelope; READY lights | 3 |
| Submit, uncertain-retry, spent, success | Card into the slot; THANKS | 4 |
| Results: ready, per-question withheld, poll withheld, withdrawn | Numbers scramble and settle; WITHHELD stays dark | 5 |
| 404, unsupported browser, popup blocked | Press stamps 404; small machine with a `?` | With the first screen that needs each |

## Copy rules

- Plain, short sentences. The illustration carries the personality; the text stays useful.
- Use the spec's required wording verbatim where it applies; never soften it.
- Success copy: "Your saved credential and answers were erased from this browser. There is no receipt or response ID, by design."
- Mockups use synthetic names, emails, and numbers only. Never copy real participant data into design files.
