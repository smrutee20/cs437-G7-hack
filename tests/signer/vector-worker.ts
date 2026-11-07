// TEST-ONLY workerd worker. Never part of the signer build or deployment.
// Exposes the pinned library's native RSA-RAW blindSign path with no key-size
// policy, so RFC 9474's 4096-bit test vector can be signed in the same runtime.
import { RSABSSA } from "@cloudflare/blindrsa-ts";

const suite = RSABSSA.SHA384.PSS.Randomized({ supportsRSARAW: true });
const hexToBytes = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
const bytesToHex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export default {
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/health") return new Response("ok");
    const { pkcs8, blindedMessage } = (await request.json()) as { pkcs8: string; blindedMessage: string };
    const key = await crypto.subtle.importKey("pkcs8", hexToBytes(pkcs8), { name: "RSA-RAW", hash: "SHA-384" }, false, ["sign"]);
    const signature = await suite.blindSign(key, hexToBytes(blindedMessage));
    return Response.json({ algorithm: key.algorithm.name, blindSignature: bytesToHex(signature) });
  },
};
