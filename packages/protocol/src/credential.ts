const MESSAGE_TAG = new TextEncoder().encode("IITGN-FEEDBACK-CREDENTIAL\0");
const SPENT_TAG = new TextEncoder().encode("IITGN-FEEDBACK-SPENT\0");
const VERSION = 1;
const SECRET_LENGTH = 32;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function pollBytes(pollId: string): Uint8Array {
  if (!UUID_V4.test(pollId)) throw new Error("pollId must be a canonical UUIDv4");
  return Uint8Array.from(pollId.replaceAll("-", "").match(/../g)!, (part) => Number.parseInt(part, 16));
}

function checkSecret(secret: Uint8Array): void {
  if (!(secret instanceof Uint8Array) || secret.length !== SECRET_LENGTH) {
    throw new Error("secret must be exactly 32 bytes");
  }
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

const BASE64URL = /^[A-Za-z0-9_-]*$/;

/** Length of the canonical unpadded base64url encoding of `byteLength` bytes. */
function base64UrlLength(byteLength: number): number {
  return Math.floor(byteLength / 3) * 4 + [0, 2, 3][byteLength % 3];
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/**
 * Decodes canonical RFC 4648 base64url without padding or whitespace. Every binary
 * wire field has a fixed size, so the expected byte length is required and checked
 * before decoding. Re-encoding rejects non-zero trailing bits.
 */
export function decodeBase64Url(text: string, expectedLength: number): Uint8Array<ArrayBuffer> {
  if (typeof text !== "string" || text.length !== base64UrlLength(expectedLength)) throw new Error("invalid base64url");
  const bytes = decodeCanonical(text);
  if (bytes.length !== expectedLength) throw new Error("invalid base64url");
  return bytes;
}

/** As `decodeBase64Url`, for variable-size fields: 1..maxLength bytes, length-checked before decoding. */
export function decodeBase64UrlUpTo(text: string, maxLength: number): Uint8Array<ArrayBuffer> {
  if (typeof text !== "string" || text.length === 0 || text.length > base64UrlLength(maxLength)) {
    throw new Error("invalid base64url");
  }
  return decodeCanonical(text);
}

function decodeCanonical(text: string): Uint8Array<ArrayBuffer> {
  if (!BASE64URL.test(text) || text.length % 4 === 1) throw new Error("invalid base64url");
  const padded = text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  if (encodeBase64Url(bytes) !== text) throw new Error("invalid base64url");
  return bytes;
}

export function encodeApplicationMessage(pollId: string, secret: Uint8Array): Uint8Array {
  checkSecret(secret);
  return concat(MESSAGE_TAG, Uint8Array.of(VERSION), pollBytes(pollId), Uint8Array.of(0, 0, 0, 1), secret);
}

export async function computeNullifier(pollId: string, secret: Uint8Array): Promise<Uint8Array> {
  checkSecret(secret);
  const input = concat(SPENT_TAG, Uint8Array.of(VERSION), pollBytes(pollId), secret);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", input));
}

export function parsePreparedMessage(prepared: Uint8Array, expectedPollId: string): {
  pollId: string;
  keyVersion: 1;
  secret: Uint8Array;
} {
  const expectedPoll = pollBytes(expectedPollId);
  if (!(prepared instanceof Uint8Array) || prepared.length !== 111) {
    throw new Error("invalid credential message");
  }
  const offset = 32;
  for (let index = 0; index < MESSAGE_TAG.length; index++) {
    if (prepared[offset + index] !== MESSAGE_TAG[index]) throw new Error("invalid credential message");
  }
  const versionAt = offset + MESSAGE_TAG.length;
  if (prepared[versionAt] !== VERSION) throw new Error("invalid credential message");
  for (let index = 0; index < expectedPoll.length; index++) {
    if (prepared[versionAt + 1 + index] !== expectedPoll[index]) throw new Error("invalid credential message");
  }
  const keyAt = versionAt + 1 + expectedPoll.length;
  if (prepared[keyAt] !== 0 || prepared[keyAt + 1] !== 0 || prepared[keyAt + 2] !== 0 || prepared[keyAt + 3] !== 1) {
    throw new Error("invalid credential message");
  }
  return { pollId: expectedPollId, keyVersion: 1, secret: prepared.slice(keyAt + 4) };
}
