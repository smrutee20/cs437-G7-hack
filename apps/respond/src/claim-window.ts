// Response side of the claim bridge handshake (SPEC.md §8, steps 1–2). Milestone 3
// adds the durable claim_sent state, claim_request/claim_result, and stored_ack.
import { newChannelNonce, parseBridgeMessage, type BridgeInit } from "@iitgn-feedback/protocol";

export type ClaimWindowState =
  | "popup_blocked"
  | "waiting_ready"
  | "waiting_ack"
  | "connected"
  | "connection_lost"
  | "bridge_closed";

export interface ClaimWindowOptions {
  portalOrigin: string;
  pollId: string;
  keyId: string;
  onChange(state: ClaimWindowState, rejectedMessages: number): void;
}

const TERMINAL: ReadonlySet<ClaimWindowState> = new Set(["popup_blocked", "connection_lost", "bridge_closed"]);

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
  let channelNonce: string | null = null; // memory only
  const set = (next: ClaimWindowState) => {
    state = next;
    options.onChange(state, rejected);
    if (TERMINAL.has(state)) cleanup();
  };
  const reject = () => options.onChange(state, ++rejected);

  const onMessage = (event: MessageEvent) => {
    if (TERMINAL.has(state)) return;
    if (event.origin !== options.portalOrigin || event.source !== bridge) return reject();
    let message;
    try {
      message = parseBridgeMessage(event.data, state === "waiting_ready" ? ["bridge_ready"] : ["bridge_ready", "bridge_ack"]);
    } catch {
      return reject();
    }
    if (message.pollId !== options.pollId) return reject();
    if (message.type === "bridge_ready") {
      // A second ready means the bridge reloaded: never silently start over.
      if (state !== "waiting_ready") return set("connection_lost");
      channelNonce = newChannelNonce();
      const init: BridgeInit = { version: 1, type: "bridge_init", pollId: options.pollId, channelNonce, keyId: options.keyId };
      bridge.postMessage(init, options.portalOrigin);
      return set("waiting_ack");
    }
    if (message.type === "bridge_ack" && state === "waiting_ack" && message.channelNonce === channelNonce) {
      return set("connected");
    }
    return reject();
  };

  const closedPoll = window.setInterval(() => {
    if (bridge.closed && !TERMINAL.has(state)) set("bridge_closed");
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
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("capability-probe", 1);
      request.onsuccess = () => {
        request.result.close();
        indexedDB.deleteDatabase("capability-probe");
        resolve();
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("blocked"));
    });
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
