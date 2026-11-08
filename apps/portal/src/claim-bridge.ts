// Portal side of the claim bridge (SPEC.md §8 message contract, steps 1–5).
// The bridge sees only public poll/key IDs, the blinded request and the blind
// signature. It asks for explicit confirmation, makes at most one HTTP claim,
// and may resend that same in-memory result for two minutes — never re-request.
import {
  CLAIM_RESULT_ERRORS, isCanonicalUuidV4, parseBridgeMessage, type BridgeAck, type BridgeMessageType, type BridgeReady,
  type ClaimRequest, type ClaimResult, type ClaimResultError,
} from "@iitgn-feedback/protocol";

export type BridgeState =
  | "invalid_link" | "direct_visit" | "unknown_poll" | "loading" | "waiting_init" | "connected"
  | "confirming" | "claiming" | "result_sent" | "expired" | "stored";
export type BridgeContext =
  | { kind: "ready"; keyId: string; title: string; email: string; csrfToken: string }
  | { kind: "login_required" }
  | { kind: "unknown" };
export type ClaimHttpOutcome = { blindSignature: string } | { error: ClaimResultError };
export type BridgeView = { state: BridgeState; rejected: number; signedIn: boolean; title?: string; email?: string };

export interface BridgeOptions {
  responseOrigin: string;
  loadContext(pollId: string): Promise<BridgeContext>;
  /** Exactly one authenticated claim attempt. Never retried by the bridge. */
  submitClaim(pollId: string, csrfToken: string, body: { keyId: string; keyVersion: 1; blindedMessage: string }): Promise<ClaimHttpOutcome>;
  onChange(view: BridgeView): void;
  resendMs?: number;
  resultWindowMs?: number;
}
export interface BridgeController { cleanup(): void; confirm(): void; cancel(): void }

const ACCEPTS: Partial<Record<BridgeState, readonly BridgeMessageType[]>> = {
  waiting_init: ["bridge_init"],
  connected: ["claim_request"],
  confirming: ["claim_request"],
  claiming: ["claim_request"],
  result_sent: ["claim_request", "stored_ack"],
};
const noop: BridgeController = { cleanup: () => {}, confirm: () => {}, cancel: () => {} };

/** Starts the bridge for this window. */
export function startClaimBridge(options: BridgeOptions): BridgeController {
  const search = new URLSearchParams(window.location.search);
  const pollId = search.get("pollId");
  // Only the public poll ID may appear in the URL; anything else is refused.
  if (!isCanonicalUuidV4(pollId) || [...search.keys()].length !== 1) {
    options.onChange({ state: "invalid_link", rejected: 0, signedIn: false });
    return noop;
  }
  const opener = window.opener as Window | null;
  if (opener === null) {
    // A direct visit has no response window to talk to and cannot claim.
    options.onChange({ state: "direct_visit", rejected: 0, signedIn: false });
    return noop;
  }

  let state: BridgeState = "loading";
  let rejected = 0;
  let context: BridgeContext = { kind: "unknown" };
  let channelNonce: string | null = null;
  let pending: ClaimRequest | null = null; // memory only
  let result: ClaimResult | null = null; // memory only
  let resend: number | undefined, expiry: number | undefined;
  let stopped = false;

  const view = (): BridgeView => ({ state, rejected, signedIn: context.kind === "ready",
    ...(context.kind === "ready" ? { title: context.title, email: context.email } : {}) });
  const set = (next: BridgeState) => { state = next; options.onChange(view()); };
  const reject = () => { rejected++; options.onChange(view()); };
  const clear = () => {
    window.clearInterval(resend);
    window.clearTimeout(expiry);
    pending = null;
    result = null;
  };

  const deliver = (outcome: ClaimHttpOutcome) => {
    let message: ClaimResult = { version: 1, type: "claim_result", pollId, channelNonce: channelNonce!, ...outcome };
    try {
      message = parseBridgeMessage(message, ["claim_result"]) as ClaimResult;
    } catch {
      // A server answer that is not a well-formed signature still consumed the claim.
      message = { version: 1, type: "claim_result", pollId, channelNonce: channelNonce!, error: "claim_consumed_no_credential" };
    }
    pending = null;
    result = message;
    const send = () => { if (result) opener.postMessage(result, options.responseOrigin); };
    send();
    resend = window.setInterval(send, options.resendMs ?? 1000);
    expiry = window.setTimeout(() => { clear(); set("expired"); }, options.resultWindowMs ?? 120_000);
    set("result_sent");
  };

  const onMessage = (event: MessageEvent) => {
    if (stopped) return;
    if (event.origin !== options.responseOrigin || event.source !== window.opener || event.source === null) return reject();
    let message;
    try {
      message = parseBridgeMessage(event.data, ACCEPTS[state] ?? []);
    } catch {
      return reject();
    }
    if (message.pollId !== pollId) return reject();
    if (message.type === "bridge_init") {
      // One init per channel, for exactly the poll and key this portal publishes.
      if (context.kind === "ready" && message.keyId !== context.keyId) return reject();
      channelNonce = message.channelNonce;
      const ack: BridgeAck = { version: 1, type: "bridge_ack", pollId, channelNonce };
      (event.source as Window).postMessage(ack, options.responseOrigin);
      return set("connected");
    }
    if (message.type === "bridge_ready" || message.channelNonce !== channelNonce) return reject();
    if (message.type === "claim_request") {
      if (state !== "connected") return reject(); // one request per channel
      if (context.kind !== "ready") return deliver({ error: "login_required" });
      if (message.keyId !== context.keyId) return reject();
      pending = message;
      return set("confirming");
    }
    if (message.type === "stored_ack") {
      clear();
      set("stored");
      stopped = true;
      window.removeEventListener("message", onMessage);
      window.close();
    }
  };

  window.addEventListener("message", onMessage);
  options.onChange(view());
  void options.loadContext(pollId).then((loaded) => {
    if (stopped) return;
    context = loaded;
    if (loaded.kind === "unknown") return set("unknown_poll");
    set("waiting_init");
    const ready: BridgeReady = { version: 1, type: "bridge_ready", pollId };
    opener.postMessage(ready, options.responseOrigin);
  });

  return {
    cleanup() {
      stopped = true;
      clear();
      window.removeEventListener("message", onMessage);
    },
    cancel() {
      if (state === "confirming") deliver({ error: "not_attempted" });
    },
    confirm() {
      if (state !== "confirming" || !pending || context.kind !== "ready") return;
      const { keyId, keyVersion, blindedMessage } = pending;
      set("claiming");
      void options.submitClaim(pollId, context.csrfToken, { keyId, keyVersion, blindedMessage })
        .catch((): ClaimHttpOutcome => ({ error: "temporarily_unavailable" }))
        .then((outcome) => { if (!stopped) deliver(outcome); });
    },
  };
}

const RELAYED = new Set<string>(CLAIM_RESULT_ERRORS.filter((code) => code !== "not_attempted" && code !== "login_required"));

/** One same-origin POST /claim. Maps the reply to a bridge outcome; anything unexpected is uncertain. */
export async function postClaim(pollId: string, csrfToken: string,
  body: { keyId: string; keyVersion: 1; blindedMessage: string }): Promise<ClaimHttpOutcome> {
  let response: Response;
  try {
    response = await fetch(`/api/v1/polls/${pollId}/claim`, {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body: JSON.stringify(body),
    });
  } catch {
    return { error: "temporarily_unavailable" }; // the request may have reached the server
  }
  let payload: unknown = null;
  try { payload = await response.json(); } catch { /* not JSON */ }
  if (response.status === 201) {
    const record = payload as Record<string, unknown> | null;
    return record && Object.keys(record).length === 1 && typeof record.blindSignature === "string"
      ? { blindSignature: record.blindSignature } : { error: "claim_consumed_no_credential" };
  }
  if (response.status === 401) return { error: "login_required" };
  const code = (payload as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === "string" && RELAYED.has(code) ? { error: code as ClaimResultError } : { error: "temporarily_unavailable" };
}
