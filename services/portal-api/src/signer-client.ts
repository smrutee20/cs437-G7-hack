// Issuer → private native signer (SPEC.md §6). Loopback HTTP only, with an
// independent service credential, a bounded timeout and no retries. Failures
// are deliberately generic; nothing here logs request or response bodies.
import { decodeBase64Url, encodeBase64Url } from "@iitgn-feedback/protocol";

export type SignerClient = {
  healthy: () => Promise<boolean>;
  sign: (key: Buffer, blinded: Uint8Array) => Promise<Uint8Array>;
};

const LOOPBACK = new Set(["127.0.0.1", "[::1]"]);
const MAX_RESPONSE_CHARS = 1024;

export function createSignerClient(options: { url: string; token: string; timeoutMs: number }): SignerClient {
  const base = new URL(options.url);
  if (base.protocol !== "http:" || !LOOPBACK.has(base.hostname) || base.username || base.password ||
      base.pathname !== "/" || base.search || base.hash) {
    throw new Error("signer must be a loopback-only service");
  }
  if (typeof options.token !== "string" || options.token.length < 32) throw new Error("signer credential unavailable");
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("invalid signer timeout");

  const call = async (path: string, init: { method: "GET" | "POST"; body?: string }) => {
    const response = await fetch(new URL(path, base), {
      method: init.method,
      body: init.body,
      headers: {
        authorization: `Bearer ${options.token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    const text = await response.text();
    if (response.status !== 200 || text.length > MAX_RESPONSE_CHARS) throw new Error("unavailable");
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("unavailable");
    return value as Record<string, unknown>;
  };

  return {
    async healthy() {
      try {
        const body = await call("/health", { method: "GET" });
        return Object.keys(body).length === 1 && body.status === "ready";
      } catch {
        return false;
      }
    },
    async sign(key, blinded) {
      try {
        // The signer accepts only this exact member order and canonical base64url.
        const body = await call("/blind-sign", { method: "POST", body: JSON.stringify({
          privateKeyPkcs8: encodeBase64Url(key), blindedMessage: encodeBase64Url(blinded),
        }) });
        if (Object.keys(body).length !== 1 || typeof body.blindSignature !== "string") throw new Error("unavailable");
        return decodeBase64Url(body.blindSignature, 384);
      } catch {
        throw new Error("signer unavailable");
      }
    },
  };
}
