// Response-origin claim steps (SPEC.md §8). The secret, prepared message and
// unblinding inverse are generated and kept here; only the blinded request
// crosses to the portal bridge, and only a blind signature comes back.
import {
  blindMessage, decodeBase64Url, encodeApplicationMessage, encodeBase64Url, finalizeSignature, importPollPublicKey,
  prepareMessage, type ClaimResult, type ClaimResultError,
} from "@iitgn-feedback/protocol";
import { claimErrorEffect } from "./claim-policy";
import {
  marker, prepareIfAbsent, transition, type ClaimSentRecord, type CredentialRecord, type Draft, type PreparedRecord, type UsableRecord,
} from "./credential-store";

export type ClaimPoll = { id: string; closesAt: string; key: { keyId: string; publicJwk: unknown } };
export type ClaimOutcome =
  | { kind: "usable" }
  | { kind: "invalid_signature" }
  | { kind: "retry" | "consumed" | "closed" | "uncertain"; code: ClaimResultError };

export function prepareCredential(poll: ClaimPoll, draft: Draft = {}): Promise<CredentialRecord> {
  return prepareIfAbsent(poll.id, async () => {
    const key = await importPollPublicKey(poll.key.publicJwk);
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const prepared = prepareMessage(encodeApplicationMessage(poll.id, secret));
    secret.fill(0);
    const { blindedMessage, inverse } = await blindMessage(key, prepared);
    return { pollId: poll.id, state: "prepared", keyId: poll.key.keyId, keyVersion: 1, closesAt: poll.closesAt,
      prepared, blinded: blindedMessage, inverse, ...(Object.keys(draft).length ? { draft: { ...draft } } : {}) };
  });
}

/** After bridge_ack: durably records claim_sent, then returns the blinded request to send. */
export async function beginClaim(pollId: string): Promise<string> {
  const sent = await transition(pollId, ["prepared"], (current): ClaimSentRecord =>
    ({ ...(current as PreparedRecord), state: "claim_sent", sentAt: Date.now() }));
  return encodeBase64Url(sent.blinded);
}

/** Applies the bridge's one result. Resolves only once the outcome is durably recorded. */
export async function finishClaim(pollId: string, publicJwk: unknown, result: ClaimResult): Promise<ClaimOutcome> {
  if ("blindSignature" in result) {
    const key = await importPollPublicKey(publicJwk);
    let outcome: ClaimOutcome = { kind: "invalid_signature" };
    await transition(pollId, ["claim_sent"], async (current) => {
      const sent = current as ClaimSentRecord;
      try {
        // finalize verifies the unblinded signature under this poll's key before returning it.
        const signature = await finalizeSignature(key, sent.prepared, decodeBase64Url(result.blindSignature, 384), sent.inverse);
        outcome = { kind: "usable" };
        const usable: UsableRecord = { pollId, state: "usable", keyId: sent.keyId, keyVersion: 1, closesAt: sent.closesAt,
          prepared: sent.prepared, signature, ...(sent.draft ? { draft: sent.draft } : {}) };
        return usable;
      } catch {
        // The entitlement may be spent; never request another signature for this browser.
        return marker(sent, "claim_consumed");
      }
    });
    return outcome;
  }
  const effect = claimErrorEffect(result.error);
  if (effect === "uncertain") return { kind: "uncertain", code: result.error };
  await transition(pollId, ["claim_sent"], (current) => {
    const sent = current as ClaimSentRecord;
    if (effect === "retry") {
      const { sentAt: _sentAt, ...rest } = sent;
      return { ...rest, state: "prepared" } satisfies PreparedRecord;
    }
    return effect === "consumed" ? marker(sent, "claim_consumed") : null;
  });
  return { kind: effect, code: result.error };
}
