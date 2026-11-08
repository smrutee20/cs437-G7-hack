// Response side of the claim bridge (SPEC.md §8 message contract, steps 1–5).
import { openCredentialDb } from "./credential-store";
import {
  newChannelNonce, parseBridgeMessage, type BridgeInit, type BridgeMessageType, type ClaimRequest, type ClaimResult,
  type StoredAck,
} from "@iitgn-feedback/protocol";

export type ClaimWindowState =
  | "popup_blocked"
  | "waiting_ready"
  | "waiting_ack"
  | "connected"
  | "request_sent"
  | "finishing"
  | "done"
  | "not_sent"
  | "connection_lost"
  | "bridge_closed";

export interface ClaimWindowOptions {
  portalOrigin: string;
  pollId: string;
  keyId: string;
  onChange(state: ClaimWindowState, rejectedMessages: number): void;
  /** Runs once after bridge_ack: durably records claim_sent, then resolves the blinded request. Reject to send nothing. */
  beginRequest(): Promise<string>;
  /** Runs for the first valid claim_result. Resolve once its outcome is durably recorded; stored_ack follows. */
  onResult(result: ClaimResult): Promise<void>;
}

const TERMINAL: ReadonlySet<ClaimWindowState> = new Set(["popup_blocked", "not_sent", "connection_lost", "bridge_closed"]);
const ACCEPTS: Partial<Record<ClaimWindowState, readonly BridgeMessageType[]>> = {
  waiting_ready: ["bridge_ready"],
  waiting_ack: ["bridge_ready", "bridge_ack"],
  connected: ["bridge_ready"],
  request_sent: ["bridge_ready", "claim_result"],
  finishing: ["bridge_ready", "claim_result"],
  done: ["claim_result"],
};

/**
 * Must be called synchronously inside the click handler that the user triggered:
 * popup permission does not survive awaited work. Returns a cleanup function.
 */
export function openClaimWindow(options: ClaimWindowOptions): () => void {
  // Only the public poll ID goes in the URL. No "noopener": the bridge needs window.opener.
  const url = `${options.portalOrigin}/claim-bridge?pollId=${encodeURIComponent(options.pollId)}`;
  const bridge = window.open(url, "_blank");
  if (bridge === null) {
    options.onChange("popup_blocked", 0);
    return () => {};
  }

  let state: ClaimWindowState = "waiting_ready";
  let rejected = 0;
  let channelNonce: string | null = null; // memory only: never sent to an API, URL, log, or store
  const set = (next: ClaimWindowState) => {
    state = next;
    options.onChange(state, rejected);
    if (TERMINAL.has(state)) cleanup();
  };
  const reject = () => options.onChange(state, ++rejected);
  const post = (message: BridgeInit | ClaimRequest | StoredAck) => bridge.postMessage(message, options.portalOrigin);
  const ack = (): StoredAck => ({ version: 1, type: "stored_ack", pollId: options.pollId, channelNonce: channelNonce! });

  const request = async () => {
    let blindedMessage: string;
    try {
      blindedMessage = await options.beginRequest();
    } catch {
      return set("not_sent");
    }
    if (state !== "connected") return; // the channel was lost while storing
    post({ version: 1, type: "claim_request", pollId: options.pollId, channelNonce: channelNonce!,
      keyId: options.keyId, keyVersion: 1, blindedMessage });
    set("request_sent");
  };

  const finish = async (result: ClaimResult) => {
    set("finishing");
    try {
      await options.onResult(result);
    } catch {
      // Not recorded (e.g. storage failed): no ack, so the bridge's resend can be processed again.
      if (state === "finishing") set("request_sent");
      return;
    }
    if (state !== "finishing") return;
    post(ack());
    set("done");
  };

  const onMessage = (event: MessageEvent) => {
    if (TERMINAL.has(state)) return;
    if (event.origin !== options.portalOrigin || event.source !== bridge) return reject();
    let message;
    try {
      message = parseBridgeMessage(event.data, ACCEPTS[state] ?? []);
    } catch {
      return reject();
    }
    if (message.pollId !== options.pollId) return reject();
    if (message.type === "bridge_ready") {
      // A second ready means the bridge reloaded: never silently start over.
      if (state !== "waiting_ready") return set("connection_lost");
      channelNonce = newChannelNonce();
      post({ version: 1, type: "bridge_init", pollId: options.pollId, channelNonce, keyId: options.keyId });
      return set("waiting_ack");
    }
    if (message.channelNonce !== channelNonce) return reject();
    if (message.type === "bridge_ack") {
      set("connected");
      void request();
      return;
    }
    if (message.type === "claim_result") {
      if (state === "request_sent") return void finish(message);
      if (state === "done") return post(ack()); // the bridge missed our ack and resent the same result
      return; // finishing: a resend while the first copy is being stored
    }
    return reject();
  };

  const closedPoll = window.setInterval(() => {
    if (!bridge.closed) return;
    if (state === "done") cleanup();
    else if (!TERMINAL.has(state)) set("bridge_closed");
  }, 250);
  function cleanup() {
    window.removeEventListener("message", onMessage);
    window.clearInterval(closedPoll);
    channelNonce = null;
  }

  window.addEventListener("message", onMessage);
  options.onChange(state, rejected);
  return cleanup;
}

/** Claiming needs Web Crypto, working IndexedDB, and Web Locks (SPEC.md §2, §8). Probes each for real. */
export async function missingClaimCapabilities(): Promise<string[]> {
  const missing: string[] = [];
  if (!window.isSecureContext || typeof crypto === "undefined" || !crypto.subtle) missing.push("Web Crypto");
  try {
    if (typeof indexedDB === "undefined" || indexedDB === null) throw new Error();
    await openCredentialDb(); // the real store; no throwaway database to create and delete
  } catch {
    missing.push("IndexedDB");
  }
  try {
    if (!navigator.locks) throw new Error();
    await navigator.locks.request("capability-probe", { ifAvailable: true }, () => undefined);
  } catch {
    missing.push("Web Locks");
  }
  return missing;
}
