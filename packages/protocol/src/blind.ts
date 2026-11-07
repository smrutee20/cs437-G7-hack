// Client/verifier side of RSABSSA-SHA384-PSS-Randomized (RFC 9474) via the pinned
// @cloudflare/blindrsa-ts. Browsers and the public verifier never sign: private
// signing happens only in the isolated native RSA-RAW signer (SPEC.md §6).
import { RSABSSA } from "@cloudflare/blindrsa-ts";
import { decodeBase64Url } from "./credential.js";

export const SUITE_NAME = "RSABSSA-SHA384-PSS-Randomized";
export const MODULUS_BITS = 3072;
export const MODULUS_BYTES = MODULUS_BITS / 8;
const APPLICATION_MESSAGE_BYTES = 79;
const PREPARED_MESSAGE_BYTES = 111;

const suite = RSABSSA.SHA384.PSS.Randomized();
if (suite.toString() !== SUITE_NAME || suite.params.saltLength !== 48) {
  throw new Error("unexpected blind RSA suite parameters");
}

export interface PollPublicJwk {
  kty: "RSA";
  n: string;
  e: "AQAB";
}

/**
 * Imports a poll's published key. Only `{kty: "RSA", n, e: "AQAB"}` with a canonical
 * 384-byte modulus is accepted; there is no algorithm negotiation (SPEC.md §6).
 */
export async function importPollPublicKey(jwk: unknown): Promise<CryptoKey> {
  const fail = (): never => {
    throw new Error("invalid poll public key");
  };
  if (typeof jwk !== "object" || jwk === null || Array.isArray(jwk)) return fail();
  const record = jwk as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 3 || keys[0] !== "e" || keys[1] !== "kty" || keys[2] !== "n") return fail();
  if (record.kty !== "RSA" || record.e !== "AQAB" || typeof record.n !== "string") return fail();
  let modulus: Uint8Array;
  try {
    modulus = decodeBase64Url(record.n, MODULUS_BYTES);
  } catch {
    return fail();
  }
  if ((modulus[0] & 0x80) === 0) return fail();
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: record.n, e: "AQAB" },
    { name: "RSA-PSS", hash: "SHA-384" },
    true, // the library reads n/e from an exported JWK while blinding
    ["verify"],
  );
  if ((key.algorithm as RsaHashedKeyAlgorithm).modulusLength !== MODULUS_BITS) return fail();
  return key;
}

/** RFC 9474 PrepareRandomize: a fresh 32-byte random prefix || the 79-byte application message. */
export function prepareMessage(applicationMessage: Uint8Array): Uint8Array {
  if (!(applicationMessage instanceof Uint8Array) || applicationMessage.length !== APPLICATION_MESSAGE_BYTES) {
    throw new Error("expected a 79-byte application message");
  }
  return suite.prepare(applicationMessage);
}

export async function blindMessage(
  key: CryptoKey,
  prepared: Uint8Array,
): Promise<{ blindedMessage: Uint8Array; inverse: Uint8Array }> {
  if (!(prepared instanceof Uint8Array) || prepared.length !== PREPARED_MESSAGE_BYTES) {
    throw new Error("expected a 111-byte prepared message");
  }
  const { blindedMsg, inv } = await suite.blind(key, prepared);
  return { blindedMessage: blindedMsg, inverse: inv };
}

/** Unblinds and verifies; throws "invalid signature" if the result does not verify under `key`. */
export function finalizeSignature(
  key: CryptoKey,
  prepared: Uint8Array,
  blindSignature: Uint8Array,
  inverse: Uint8Array,
): Promise<Uint8Array> {
  return suite.finalize(key, prepared, blindSignature, inverse);
}

export function verifySignature(key: CryptoKey, prepared: Uint8Array, signature: Uint8Array): Promise<boolean> {
  return suite.verify(key, signature, prepared);
}
