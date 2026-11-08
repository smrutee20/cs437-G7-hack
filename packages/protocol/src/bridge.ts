// Portal ↔ response bridge handshake messages (SPEC.md §8 "Message contract").
// Origin and source-window checks belong to the callers; this module checks shape.
import { decodeBase64Url, encodeBase64Url, isCanonicalUuidV4 } from "./credential.js";

export type BridgeMessageType =
  "bridge_ready" | "bridge_init" | "bridge_ack" | "claim_request" | "claim_result" | "stored_ack";
export type BridgeReady = { version: 1; type: "bridge_ready"; pollId: string };
export type BridgeInit = { version: 1; type: "bridge_init"; pollId: string; channelNonce: string; keyId: string };
export type BridgeAck = { version: 1; type: "bridge_ack"; pollId: string; channelNonce: string };
/** Nonce, key ID/version and blinded message only: never a secret, prepared message, or inverse. */
export type ClaimRequest = {
  version: 1; type: "claim_request"; pollId: string; channelNonce: string; keyId: string; keyVersion: 1; blindedMessage: string;
};
/** Bridge-visible claim outcomes: the portal API's claim codes plus the two that need no HTTP attempt. */
export const CLAIM_RESULT_ERRORS = [
  "not_attempted", "login_required", "csrf_failed", "forbidden", "invalid_request", "not_found", "not_eligible",
  "rate_limited", "capacity_unavailable", "poll_closed", "poll_withdrawn", "claim_consumed",
  "claim_consumed_no_credential", "temporarily_unavailable",
] as const;
export type ClaimResultError = typeof CLAIM_RESULT_ERRORS[number];
export type ClaimResult = { version: 1; type: "claim_result"; pollId: string; channelNonce: string } &
  ({ blindSignature: string } | { error: ClaimResultError });
export type StoredAck = { version: 1; type: "stored_ack"; pollId: string; channelNonce: string };
export type BridgeMessage = BridgeReady | BridgeInit | BridgeAck | ClaimRequest | ClaimResult | StoredAck;

export const BRIDGE_MAX_BYTES = 2048;
const NONCE_BYTES = 32;
const MODULUS_BYTES = 384;

const FIELDS: Record<Exclude<BridgeMessageType, "claim_result">, readonly string[]> = {
  bridge_ready: ["pollId", "type", "version"],
  bridge_init: ["channelNonce", "keyId", "pollId", "type", "version"],
  bridge_ack: ["channelNonce", "pollId", "type", "version"],
  claim_request: ["blindedMessage", "channelNonce", "keyId", "keyVersion", "pollId", "type", "version"],
  stored_ack: ["channelNonce", "pollId", "type", "version"],
};
const RESULT_FIELDS = {
  signed: ["blindSignature", "channelNonce", "pollId", "type", "version"],
  failed: ["channelNonce", "error", "pollId", "type", "version"],
} as const;

const invalid = (): never => {
  throw new Error("invalid bridge message");
};

function isBytes(value: unknown, length: number): boolean {
  try {
    decodeBase64Url(value as string, length);
    return true;
  } catch {
    return false;
  }
}
const isNonce = (value: unknown) => isBytes(value, NONCE_BYTES);

/** Parses structured-clone `event.data`; `allowed` lists the types valid in the caller's current state. */
export function parseBridgeMessage(data: unknown, allowed: readonly BridgeMessageType[]): BridgeMessage {
  if (typeof data !== "object" || data === null || Object.getPrototypeOf(data) !== Object.prototype) return invalid();
  let serialized: string;
  try {
    serialized = JSON.stringify(data);
  } catch {
    return invalid();
  }
  if (new TextEncoder().encode(serialized).length > BRIDGE_MAX_BYTES) return invalid();
  const record = data as Record<string, unknown>;
  const type = record.type as BridgeMessageType;
  if (!allowed.includes(type) || !(type in FIELDS || type === "claim_result")) return invalid();
  const keys = Object.keys(record).sort();
  const expected = type === "claim_result"
    ? ("blindSignature" in record ? RESULT_FIELDS.signed : RESULT_FIELDS.failed)
    : FIELDS[type];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return invalid();
  if (record.version !== 1 || !isCanonicalUuidV4(record.pollId)) return invalid();
  if (type !== "bridge_ready" && !isNonce(record.channelNonce)) return invalid();
  if ((type === "bridge_init" || type === "claim_request") && !isCanonicalUuidV4(record.keyId)) return invalid();
  if (type === "claim_request" && (record.keyVersion !== 1 || !isBytes(record.blindedMessage, MODULUS_BYTES))) return invalid();
  if (type === "claim_result" && ("blindSignature" in record
    ? !isBytes(record.blindSignature, MODULUS_BYTES)
    : !(CLAIM_RESULT_ERRORS as readonly unknown[]).includes(record.error))) return invalid();
  return { ...record } as BridgeMessage;
}

/** Fresh per-connection 32-byte nonce. Browser memory only: never sent to an API, URL, log, or store. */
export function newChannelNonce(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}
