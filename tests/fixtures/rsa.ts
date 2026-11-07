// Test-side RSA helpers. Node/OpenSSL acts as an independent signer/verifier;
// none of this is production code.
import { constants, createPrivateKey, generateKeyPairSync, privateDecrypt, verify, type KeyObject } from "node:crypto";
import { rfc9474A1 as v } from "./rfc9474-a1";

export const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
export const b64u = (hex: string) => Buffer.from(hex, "hex").toString("base64url");
const big = (hex: string) => BigInt(`0x${hex}`);
const hexOf = (value: bigint) => {
  const hex = value.toString(16);
  return hex.length % 2 ? `0${hex}` : hex;
};
function modInverse(a: bigint, m: bigint): bigint {
  let [oldR, r, oldS, s] = [a % m, m, 1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  return ((oldS % m) + m) % m;
}

/** RFC 9474 A.1 private key, with CRT parameters derived from p, q, d. */
export function rfcPrivateKey(): KeyObject {
  const [p, q, d] = [big(v.p), big(v.q), big(v.d)];
  return createPrivateKey({
    format: "jwk",
    key: {
      kty: "RSA", n: b64u(v.n), e: b64u(v.e), d: b64u(v.d), p: b64u(v.p), q: b64u(v.q),
      dp: b64u(hexOf(d % (p - 1n))), dq: b64u(hexOf(d % (q - 1n))), qi: b64u(hexOf(modInverse(q, p))),
    },
  });
}

/** Independent native raw RSA private operation (OpenSSL). */
export const nodeRawSign = (key: KeyObject, blinded: Uint8Array) =>
  Uint8Array.from(privateDecrypt({ key, padding: constants.RSA_NO_PADDING }, blinded));

/** Independent RSASSA-PSS (SHA-384, MGF1-SHA-384, 48-byte salt) verification (OpenSSL). */
export const nodeVerifyPss = (key: KeyObject, message: Uint8Array, signature: Uint8Array) =>
  verify("sha384", message, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 48 }, signature);

export function freshKey(modulusLength = 3072, publicExponent = 65537) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength, publicExponent });
  const { kty, n, e } = publicKey.export({ format: "jwk" });
  return {
    privateKey,
    publicKey,
    jwk: { kty, n, e },
    pkcs8: Uint8Array.from(privateKey.export({ format: "der", type: "pkcs8" })),
  };
}
