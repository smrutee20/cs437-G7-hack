// Participant-facing text. Mandatory wording (SPEC.md §3) is verbatim.
import type { ClaimOutcome } from "./claim-flow";
import type { ClaimWindowState } from "./claim-window";
import type { SubmitOutcome } from "./submit-flow";

export const PRIVACY_NOTICE = "Your institutional account is checked to issue one credential. The response service does not require sign-in, " +
  "and answers are not stored with your account identity. A credential can be used once and can be lost or shared. Do not include " +
  "identifying details in your answers. Free text, small result categories, outside knowledge, and network metadata may reveal you. " +
  "The platform and its infrastructure must be trusted. This is not an election system or a guarantee of absolute anonymity.";
export const LOSS_WARNING = "A credential can be used once and can be lost or shared. It is kept only in this browser's storage: clearing " +
  "site data, private browsing or losing this device loses it, and it can't be replaced for this poll. Don't claim right before the deadline.";
export const TEXT_WARNING = "Free text may identify you. Do not include identifying details in your answers; readers may make inferences from what you say.";
export const SUBMIT_WARNING = "Before you submit: do not include identifying details. Free text, small result categories, outside knowledge, " +
  "and network metadata may reveal you.";
export const SUCCESS_BODY = "Your saved credential and answers were erased from this browser. There is no receipt or response ID, by design.";

export const WINDOW_TEXT: Partial<Record<ClaimWindowState, string>> = {
  popup_blocked: "Your browser blocked the claim window. Allow pop-ups for this site, then choose “Open claim window” again.",
  waiting_ready: "Waiting for the claim window…",
  waiting_ack: "Connecting to the claim window…",
  connected: "Connected. Saving the claim attempt in this browser…",
  request_sent: "Confirm in the portal window.",
  finishing: "Checking and storing the stamped credential…",
  connection_lost: "The claim window was reloaded, so the connection was closed.",
  bridge_closed: "The claim window closed.",
};

const RETRY_TEXT: Record<string, string> = {
  not_attempted: "No claim was made. You can open the claim window again.",
  login_required: "Sign in to the portal in another tab, then open the claim window again. No claim was made.",
  not_eligible: "This account is not on this poll's eligibility list. No claim was made.",
  rate_limited: "Too many claim attempts. Wait a minute, then try again. No claim was made.",
  capacity_unavailable: "The service is busy. No claim was made; try again shortly.",
};
export function outcomeText(outcome: ClaimOutcome): string {
  switch (outcome.kind) {
    case "usable": return "Credential received, verified and stored in this browser.";
    case "invalid_signature": return "The claim window returned a signature that did not verify. This browser cannot respond.";
    case "retry": return RETRY_TEXT[outcome.code] ?? "The portal refused the request. No claim was made.";
    case "consumed": return outcome.code === "claim_consumed_no_credential"
      ? "A credential was claimed but could not be issued. This browser cannot respond."
      : "A credential for your account on this poll has already been claimed.";
    case "closed": return "This poll is closed or withdrawn, so nothing can be claimed.";
    case "uncertain": return "The outcome of this claim is unknown. Do not start another claim; this page will mark the " +
      "attempt as uncertain if no result arrives.";
  }
}

export function submitText(outcome: SubmitOutcome): string {
  switch (outcome.kind) {
    case "accepted": return "Your response was recorded.";
    case "spent": return "This credential was already used with different answers, so these answers were not recorded.";
    case "closed": return "This poll is closed or withdrawn, so these answers were not recorded.";
    case "invalid_credential": return "The response service rejected the credential. These answers were not recorded.";
    case "edit": return `The response service rejected these answers${outcome.field ? ` (${outcome.field})` : ""}. Edit them and submit again.`;
    case "retry_later": return "Too many submissions right now. Try again shortly.";
    case "uncertain": return "Your submission could not be confirmed. Your exact answers are kept; use “Retry submission” to resend them.";
  }
}

/** Booth display text, headline and body per state. Display text is system voice only. */
export type BoothView = { display: string; lit: boolean; leds: "off" | "run" | "lit"; ledge: "empty" | "envelope" | "card" | "question";
  cardIn?: boolean; headline: string; body: string; step: 0 | 1 | 2 | 3 };
export const BOOTH: Record<string, Omit<BoothView, "display"> & { display?: string }> = {
  none: { lit: false, leds: "off", ledge: "empty", step: 1, headline: "Get your one-time credential",
    body: "Draft your answers any time. To submit, this browser seals a credential in an envelope, and the portal stamps it without seeing inside." },
  prepared: { display: "SEALED", lit: false, leds: "off", ledge: "envelope", step: 2, headline: "Envelope sealed",
    body: "Your credential is sealed in this browser. Next, open the portal window to get it stamped. That uses your one claim for this poll." },
  waiting: { display: "WAIT", lit: false, leds: "run", ledge: "empty", step: 2, headline: "Waiting for the portal window",
    body: "Confirm in the portal window. Keep this tab open until the stamped envelope comes back." },
  claim_sent: { display: "WAIT", lit: false, leds: "run", ledge: "empty", step: 2, headline: "Claim in progress",
    body: "A claim from this browser is in progress or its outcome is unknown. No new claim will be started from this browser." },
  usable: { display: "READY", lit: true, leds: "lit", ledge: "card", step: 3, headline: "Credential ready",
    body: "Stamped and checked in this browser. Review your answers, then submit. You can submit only once." },
  sending: { display: "SEND", lit: false, leds: "run", ledge: "card", cardIn: true, step: 3, headline: "Sending",
    body: "Your answers are locked while this finishes. If the connection drops, the exact same submission can be retried." },
  submit_pending: { display: "RETRY", lit: false, leds: "off", ledge: "card", step: 3, headline: "Submission not confirmed",
    body: "Your answers are saved in this browser with the credential. Their submission is not confirmed yet. Retrying resends exactly the same answers." },
  accepted: { display: "THANKS", lit: true, leds: "lit", ledge: "empty", step: 0, headline: "Response received", body: SUCCESS_BODY },
  spent: { display: "SPENT", lit: false, leds: "off", ledge: "empty", step: 0, headline: "Credential already used",
    body: "This credential was already used with different answers. It has been erased from this browser." },
  claim_consumed: { display: "USED", lit: false, leds: "off", ledge: "empty", step: 0, headline: "Claim already used",
    body: "A credential for your account on this poll has already been claimed, or a claim was used up without delivering a credential. This browser cannot respond to this poll." },
  claim_uncertain: { display: "?", lit: false, leds: "off", ledge: "question", step: 0, headline: "Claim outcome unknown",
    body: "An earlier claim from this browser has an unknown outcome, so it cannot claim again. This browser cannot respond to this poll." },
  credential_invalid: { display: "ERROR", lit: false, leds: "off", ledge: "empty", step: 0, headline: "Credential rejected",
    body: "The response service rejected this browser's credential as invalid, so this browser cannot respond." },
  closed: { display: "CLOSED", lit: false, leds: "off", ledge: "empty", step: 0, headline: "This poll is closed",
    body: "No new credentials or responses are accepted. No credential is stored in this browser for this poll." },
  withdrawn: { display: "CLOSED", lit: false, leds: "off", ledge: "empty", step: 0, headline: "This poll was withdrawn",
    body: "The operator withdrew this poll. It must not be relied upon, and it accepts nothing further." },
  unsupported: { display: "?", lit: false, leds: "off", ledge: "empty", step: 0, headline: "This browser can't claim a credential", body: "" },
  loading: { display: "", lit: false, leds: "off", ledge: "empty", step: 0, headline: "Checking this browser…", body: "" },
};

/** Deadline countdown for the booth display (≤ 6 glyphs) plus a full accessible description. */
export function countdown(closesAt: string, now = Date.now()): { display: string; label: string } {
  const minutes = Math.max(0, Math.floor((Date.parse(closesAt) - now) / 60_000));
  const days = Math.floor(minutes / 1440), hours = Math.floor((minutes % 1440) / 60), mins = minutes % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  const display = days >= 10 ? `${days}D${pad(hours)}H` : days >= 1 ? `${days}D ${pad(hours)}H` : `${pad(hours)}:${pad(mins)}`;
  const label = days >= 1 ? `Closes in ${days} day${days === 1 ? "" : "s"}, ${hours} hour${hours === 1 ? "" : "s"}`
    : `Closes in ${hours} hour${hours === 1 ? "" : "s"}, ${mins} minute${mins === 1 ? "" : "s"}`;
  return { display, label };
}
