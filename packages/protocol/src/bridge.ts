// Portal ↔ response bridge handshake messages (SPEC.md §8 "Message contract").
// Origin and source-window checks belong to the callers; this module checks shape.
import { decodeBase64Url, encodeBase64Url, isCanonicalUuidV4 } from "./credential.js";

export type BridgeMessageType = "bridge_ready" | "bridge_init" | "bridge_ack";
export type BridgeReady = { version: 1; type: "bridge_ready"; pollId: string };
export type BridgeInit = { version: 1; type: "bridge_init"; pollId: string; channelNonce: string; keyId: string };
export type BridgeAck = { version: 1; type: "bridge_ack"; pollId: string; channelNonce: string };
export type BridgeMessage = BridgeReady | BridgeInit | BridgeAck;

export const BRIDGE_MAX_BYTES = 2048;
const NONCE_BYTES = 32;

const FIELDS: Record<BridgeMessageType, readonly string[]> = {
  bridge_ready: ["pollId", "type", "version"],
  bridge_init: ["channelNonce", "keyId", "pollId", "type", "version"],
  bridge_ack: ["channelNonce", "pollId", "type", "version"],
};

const invalid = (): never => {
  throw new Error("invalid bridge message");
};

function isNonce(value: unknown): boolean {
  try {
    decodeBase64Url(value as string, NONCE_BYTES);
    return true;
  } catch {
    return false;
  }
}

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
  if (!allowed.includes(type) || !(type in FIELDS)) return invalid();
  const keys = Object.keys(record).sort();
  const expected = FIELDS[type];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return invalid();
  if (record.version !== 1 || !isCanonicalUuidV4(record.pollId)) return invalid();
  if (type !== "bridge_ready" && !isNonce(record.channelNonce)) return invalid();
  if (type === "bridge_init" && !isCanonicalUuidV4(record.keyId)) return invalid();
  return { ...record } as BridgeMessage;
}

/** Fresh per-connection 32-byte nonce. Browser memory only: never sent to an API, URL, log, or store. */
export function newChannelNonce(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}
