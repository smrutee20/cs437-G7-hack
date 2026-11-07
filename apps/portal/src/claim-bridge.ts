// Portal side of the claim bridge handshake (SPEC.md §8, steps 1–2). Milestone 3
// adds the authenticated claim request/result and stored_ack on this channel.
import { isCanonicalUuidV4, parseBridgeMessage, type BridgeAck, type BridgeReady } from "@iitgn-feedback/protocol";

export type BridgeState = "invalid_link" | "direct_visit" | "unknown_poll" | "waiting_init" | "connected";

export interface BridgeOptions {
  responseOrigin: string;
  /** Public key ID the portal publishes for this poll (claim-context API in Milestone 3). */
  lookupKeyId(pollId: string): string | undefined;
  onChange(state: BridgeState, rejectedMessages: number): void;
}

/** Starts the bridge for this window. Returns a cleanup function. */
export function startClaimBridge(options: BridgeOptions): () => void {
  const search = new URLSearchParams(window.location.search);
  const pollId = search.get("pollId");
  // Only the public poll ID may appear in the URL; anything else is refused.
  if (!isCanonicalUuidV4(pollId) || [...search.keys()].length !== 1) {
    options.onChange("invalid_link", 0);
    return () => {};
  }
  const opener = window.opener as Window | null;
  if (opener === null) {
    // A direct visit has no response window to talk to and cannot claim.
    options.onChange("direct_visit", 0);
    return () => {};
  }
  const keyId = options.lookupKeyId(pollId);
  if (keyId === undefined) {
    options.onChange("unknown_poll", 0);
    return () => {};
  }

  let state: BridgeState = "waiting_init";
  let rejected = 0;
  const reject = () => options.onChange(state, ++rejected);

  const onMessage = (event: MessageEvent) => {
    if (event.origin !== options.responseOrigin || event.source !== window.opener || event.source === null) return reject();
    let message;
    try {
      message = parseBridgeMessage(event.data, ["bridge_init"]);
    } catch {
      return reject();
    }
    // One init per channel, for exactly the poll and key this portal publishes.
    if (state !== "waiting_init" || message.type !== "bridge_init" || message.pollId !== pollId || message.keyId !== keyId) {
      return reject();
    }
    state = "connected";
    const ack: BridgeAck = { version: 1, type: "bridge_ack", pollId, channelNonce: message.channelNonce };
    (event.source as Window).postMessage(ack, options.responseOrigin);
    options.onChange(state, rejected);
  };

  window.addEventListener("message", onMessage);
  options.onChange(state, rejected);
  const ready: BridgeReady = { version: 1, type: "bridge_ready", pollId };
  opener.postMessage(ready, options.responseOrigin);
  return () => window.removeEventListener("message", onMessage);
}
