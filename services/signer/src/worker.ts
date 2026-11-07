// Private native RSA-RAW blind signer (SPEC.md §6). Runs only in the pinned workerd
// runtime on a loopback socket and is called only by the issuer. It never logs,
// never returns key material or native error text, and performs no PSS
// preparation: the client has already blinded the PSS-encoded message.
import { RSABSSA } from "@cloudflare/blindrsa-ts";
import { decodeBase64Url, decodeBase64UrlUpTo, encodeBase64Url } from "@iitgn-feedback/protocol";
import { assertPublicOperationMatches } from "./fault-check.js";

interface Env {
  SIGNER_SERVICE_TOKEN: string | null;
}

const MODULUS_BITS = 3072;
const MODULUS_BYTES = MODULUS_BITS / 8;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_PKCS8_BYTES = 4096;
const MIN_TOKEN_LENGTH = 32;
const suite = RSABSSA.SHA384.PSS.Randomized({ supportsRSARAW: true });

class Rejected extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

const reply = (status: number, body: Record<string, string>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const token = env.SIGNER_SERVICE_TOKEN;
      if (typeof token !== "string" || token.length < MIN_TOKEN_LENGTH) throw new Rejected(503, "unavailable");
      if (!(await authorized(request, token))) throw new Rejected(401, "unauthorized");
      const { pathname } = new URL(request.url);
      if (pathname === "/health") {
        if (request.method !== "GET") throw new Rejected(405, "method_not_allowed");
        return reply(200, { status: "ready" });
      }
      if (pathname === "/blind-sign") {
        if (request.method !== "POST") throw new Rejected(405, "method_not_allowed");
        const { privateKeyPkcs8, blindedMessage } = parseRequest(await readBody(request));
        return reply(200, { blindSignature: encodeBase64Url(await blindSign(privateKeyPkcs8, blindedMessage)) });
      }
      throw new Rejected(404, "not_found");
    } catch (error) {
      // Deliberately no logging and no detail: bodies are fixed strings.
      if (error instanceof Rejected) return reply(error.status, { error: error.code });
      return reply(500, { error: "signing_failed" });
    }
  },
};

async function authorized(request: Request, token: string): Promise<boolean> {
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  const digest = (value: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const [a, b] = await Promise.all([digest(presented), digest(token)]);
  // workerd's non-standard constant-time comparison.
  return (crypto.subtle as SubtleCrypto & { timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean })
    .timingSafeEqual(a, b);
}

async function readBody(request: Request): Promise<string> {
  if ((request.headers.get("content-type") ?? "").split(";")[0].trim() !== "application/json") {
    throw new Rejected(415, "unsupported_media_type");
  }
  const declared = request.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= MAX_BODY_BYTES)) throw new Rejected(413, "too_large");
  if (request.body === null) throw new Rejected(400, "invalid_request");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Rejected(413, "too_large");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new Rejected(400, "invalid_request");
  }
}

/**
 * Accepts only the exact serialization `{"privateKeyPkcs8":"…","blindedMessage":"…"}`
 * (member order fixed, no whitespace, duplicates, or extra members), with canonical
 * unpadded base64url values.
 */
function parseRequest(text: string): { privateKeyPkcs8: Uint8Array<ArrayBuffer>; blindedMessage: Uint8Array<ArrayBuffer> } {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    const { privateKeyPkcs8, blindedMessage } = value as Record<string, unknown>;
    if (typeof privateKeyPkcs8 !== "string" || typeof blindedMessage !== "string") throw new Error();
    if (JSON.stringify({ privateKeyPkcs8, blindedMessage }) !== text) throw new Error();
    return {
      privateKeyPkcs8: decodeBase64UrlUpTo(privateKeyPkcs8, MAX_PKCS8_BYTES),
      blindedMessage: decodeBase64Url(blindedMessage, MODULUS_BYTES),
    };
  } catch {
    throw new Rejected(400, "invalid_request");
  }
}

async function blindSign(pkcs8: Uint8Array<ArrayBuffer>, blinded: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  // Public parameters for policy, range, and fault checks. Import failures are input errors.
  let modulus: Uint8Array;
  let exponent: Uint8Array;
  let rawKey: CryptoKey;
  try {
    const metadataKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "RSA-PSS", hash: "SHA-384" }, true, ["sign"]);
    const jwk = await crypto.subtle.exportKey("jwk", metadataKey);
    modulus = decodeBase64Url(jwk.n ?? "", MODULUS_BYTES);
    exponent = decodeBase64UrlUpTo(jwk.e ?? "", 8);
    rawKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "RSA-RAW", hash: "SHA-384" }, false, ["sign"]);
  } catch {
    throw new Rejected(400, "invalid_request");
  }
  const algorithm = rawKey.algorithm as RsaHashedKeyAlgorithm;
  if (
    algorithm.name !== "RSA-RAW" ||
    algorithm.modulusLength !== MODULUS_BITS ||
    (modulus[0] & 0x80) === 0 ||
    !equalBytes(exponent, Uint8Array.of(1, 0, 1)) ||
    !equalBytes(new Uint8Array(algorithm.publicExponent), Uint8Array.of(1, 0, 1))
  ) {
    throw new Rejected(400, "invalid_request");
  }
  // 0 < m < n on equal-length big-endian byte strings; no truncation or reduction.
  if (blinded.every((byte) => byte === 0) || compareBytes(blinded, modulus) >= 0) {
    throw new Rejected(400, "invalid_request");
  }

  const signature = await suite.blindSign(rawKey, blinded); // native RSA-RAW private operation
  if (signature.length !== MODULUS_BYTES) throw new Error("unexpected signature size");

  // A mismatch throws, so a faulty signature is never released.
  assertPublicOperationMatches(modulus, exponent, blinded, signature);
  return signature;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && compareBytes(a, b) === 0;
}
