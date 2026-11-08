import { createPrivateKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { chmodSync, readFileSync, statSync, writeFileSync, mkdtempSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, inject, test } from "vitest";
import { blindMessage, finalizeSignature, importPollPublicKey, prepareMessage, verifySignature } from "../../packages/protocol/src/blind";
import { encodeApplicationMessage } from "../../packages/protocol/src/credential";
import { rfc9474A1 as v } from "../fixtures/rfc9474-a1";
import { bytes, freshKey, nodeRawSign, nodeVerifyPss, rfcPrivateKey } from "../fixtures/rsa";

const url = inject("signerUrl");
const token = inject("signerToken");
const b64 = (value: Uint8Array) => Buffer.from(value).toString("base64url");
const sentMaterial: string[] = [];
const GENERIC_ERRORS = new Set([
  '{"error":"invalid_request"}', '{"error":"unauthorized"}', '{"error":"too_large"}', '{"error":"signing_failed"}',
  '{"error":"not_found"}', '{"error":"method_not_allowed"}', '{"error":"unsupported_media_type"}',
]);

async function call(body: string, init: { token?: string; contentType?: string; method?: string; path?: string } = {}) {
  const response = await fetch(`${url}${init.path ?? "/blind-sign"}`, {
    method: init.method ?? "POST",
    headers: {
      authorization: `Bearer ${init.token ?? token}`,
      "content-type": init.contentType ?? "application/json",
    },
    body: (init.method ?? "POST") === "GET" ? undefined : body,
  });
  return { status: response.status, text: await response.text() };
}

function requestBody(pkcs8: Uint8Array, blinded: Uint8Array) {
  const body = JSON.stringify({ privateKeyPkcs8: b64(pkcs8), blindedMessage: b64(blinded) });
  sentMaterial.push(b64(pkcs8), b64(blinded));
  return body;
}

async function clientBlind(jwk: unknown, pollId = "123e4567-e89b-42d3-a456-426614174000") {
  const key = await importPollPublicKey(jwk);
  const prepared = prepareMessage(encodeApplicationMessage(pollId, crypto.getRandomValues(new Uint8Array(32))));
  return { key, prepared, ...(await blindMessage(key, prepared)) };
}

async function signOk(pkcs8: Uint8Array, blinded: Uint8Array): Promise<Uint8Array> {
  const { status, text } = await call(requestBody(pkcs8, blinded));
  expect(status, text).toBe(200);
  const parsed = JSON.parse(text) as Record<string, unknown>;
  expect(Object.keys(parsed)).toEqual(["blindSignature"]);
  const signature = Buffer.from(parsed.blindSignature as string, "base64url");
  expect(b64(signature)).toBe(parsed.blindSignature);
  return Uint8Array.from(signature);
}

function expectGenericRejection(result: { status: number; text: string }, status: number) {
  expect(result.status).toBe(status);
  expect(GENERIC_ERRORS.has(result.text), result.text).toBe(true);
}

describe("native RSA-RAW signer in pinned workerd", () => {
  const poll = freshKey();

  test("round trip: client blind → native sign → finalize → verify (library and OpenSSL)", async () => {
    const { key, prepared, blindedMessage, inverse } = await clientBlind(poll.jwk);
    const blindSignature = await signOk(poll.pkcs8, blindedMessage);
    expect(blindSignature.length).toBe(384);
    const signature = await finalizeSignature(key, prepared, blindSignature, inverse);
    expect(await verifySignature(key, prepared, signature)).toBe(true);
    expect(nodeVerifyPss(poll.publicKey as unknown as KeyObject, prepared, signature)).toBe(true);
  });

  test("native output equals an independent OpenSSL raw private operation on the same input", async () => {
    const { blindedMessage } = await clientBlind(poll.jwk);
    expect(Buffer.from(await signOk(poll.pkcs8, blindedMessage)).equals(Buffer.from(nodeRawSign(poll.privateKey, blindedMessage)))).toBe(true);
  });

  test("RFC 9474 A.1: the library's native RSA-RAW path in workerd reproduces blind_sig", async () => {
    const pkcs8 = rfcPrivateKey().export({ format: "der", type: "pkcs8" }).toString("hex");
    const response = await fetch(inject("vectorSignerUrl"), {
      method: "POST",
      body: JSON.stringify({ pkcs8, blindedMessage: v.blinded_msg }),
    });
    expect(await response.json()).toEqual({ algorithm: "RSA-RAW", blindSignature: v.blind_sig });
  });

  test("two independent poll keys: a signature from A's key does not finalize under B's key", async () => {
    const pollB = freshKey();
    const nA = Buffer.from(poll.jwk.n as string, "base64url");
    // A value blinded mod n_B is >= n_A about half the time; the signer must refuse
    // those as out of range for A. Re-blind until A can sign, to exercise finalization.
    let blinded: Awaited<ReturnType<typeof clientBlind>>;
    for (let attempt = 0; ; attempt++) {
      blinded = await clientBlind(pollB.jwk, "9b2f4c1e-7d3a-4e8b-a1c2-5f6e7d8c9b0a");
      if (Buffer.compare(Buffer.from(blinded.blindedMessage), nA) < 0) break;
      expectGenericRejection(await call(requestBody(poll.pkcs8, blinded.blindedMessage)), 400);
      expect(attempt).toBeLessThan(40);
    }
    const { key, prepared, blindedMessage, inverse } = blinded;
    const fromA = await signOk(poll.pkcs8, blindedMessage);
    await expect(finalizeSignature(key, prepared, fromA, inverse)).rejects.toThrow(/invalid signature/);
    const fromB = await signOk(pollB.pkcs8, blindedMessage);
    expect(await verifySignature(key, prepared, await finalizeSignature(key, prepared, fromB, inverse))).toBe(true);
  });

  test("a key stored at rest keeps signing for the same published public key across a signer restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "feedback-key-"));
    const path = join(dir, "poll.pkcs8");
    writeFileSync(path, poll.pkcs8, { mode: 0o600 });
    chmodSync(path, 0o600);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const before = await clientBlind(poll.jwk);
    const sigBefore = await finalizeSignature(before.key, before.prepared, await signOk(poll.pkcs8, before.blindedMessage), before.inverse);

    await new Promise<void>((resolveRestart, reject) => {
      const [host, port] = inject("signerControlUrl").split(":");
      const socket = connect(Number(port), host, () => socket.write("restart"));
      socket.on("data", () => resolveRestart());
      socket.on("error", reject);
    });

    const stored = Uint8Array.from(readFileSync(path));
    const after = await clientBlind(poll.jwk);
    const sigAfter = await finalizeSignature(after.key, after.prepared, await signOk(stored, after.blindedMessage), after.inverse);
    expect(await verifySignature(before.key, before.prepared, sigBefore)).toBe(true);
    expect(await verifySignature(before.key, after.prepared, sigAfter)).toBe(true);
  });
});

describe("signer input, range, key-policy, and access rejection", () => {
  const poll = freshKey();
  const n = Buffer.from(poll.jwk.n as string, "base64url");
  const valid = () => Uint8Array.from(Buffer.alloc(384, 1));

  test("requires the service credential on every route", async () => {
    expectGenericRejection(await call(requestBody(poll.pkcs8, valid()), { token: "wrong".repeat(10) }), 401);
    expectGenericRejection(await call("", { method: "GET", path: "/health", token: "" }), 401);
    expect((await call("", { method: "GET", path: "/health" })).text).toBe('{"status":"ready"}');
  });

  test.each([
    ["383 bytes", Uint8Array.from(Buffer.alloc(383, 1))],
    ["385 bytes", Uint8Array.from(Buffer.alloc(385, 1))],
    ["m = 0", new Uint8Array(384)],
    ["m = n", Uint8Array.from(n)],
    ["m > n", Uint8Array.from(Buffer.alloc(384, 0xff))],
  ])("rejects a blinded message with %s before signing", async (_label, blinded) => {
    expectGenericRejection(await call(requestBody(poll.pkcs8, blinded)), 400);
  });

  test("accepts m = n - 1 (upper boundary)", async () => {
    const nMinusOne = Uint8Array.from(n);
    nMinusOne[383] -= 1; // n is odd, so its last byte is non-zero
    expect((await call(requestBody(poll.pkcs8, nMinusOne))).status).toBe(200);
  });

  test.each([
    ["2048-bit", () => freshKey(2048).pkcs8],
    ["4096-bit", () => freshKey(4096).pkcs8],
    ["e = 3", () => freshKey(3072, 3).pkcs8],
    ["EC", () => Uint8Array.from(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "der", type: "pkcs8" }))],
    ["truncated PKCS#8", () => poll.pkcs8.subarray(0, 600)],
  ])("rejects a %s private key", async (_label, makeKey) => {
    const result = await call(requestBody(makeKey(), valid()));
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(GENERIC_ERRORS.has(result.text), result.text).toBe(true);
  });

  test("never releases a signature for a key with corrupted CRT parameters", async () => {
    const jwk = poll.privateKey.export({ format: "jwk" });
    const dp = Buffer.from(jwk.dp as string, "base64url");
    dp[dp.length - 1] ^= 0x01;
    let corrupted: Uint8Array;
    try {
      corrupted = Uint8Array.from(createPrivateKey({ format: "jwk", key: { ...jwk, dp: dp.toString("base64url") } })
        .export({ format: "der", type: "pkcs8" }));
    } catch {
      return expect.fail("could not build a corrupted test key");
    }
    const result = await call(requestBody(corrupted, valid()));
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.text).not.toContain("blindSignature");
    expect(GENERIC_ERRORS.has(result.text), result.text).toBe(true);
  });

  test.each([
    ["padded base64url", (k: string, m: string) => `{"privateKeyPkcs8":"${k}","blindedMessage":"${m}="}`],
    ["reordered members", (k: string, m: string) => `{"blindedMessage":"${m}","privateKeyPkcs8":"${k}"}`],
    ["whitespace", (k: string, m: string) => `{"privateKeyPkcs8": "${k}","blindedMessage":"${m}"}`],
    ["duplicate member", (k: string, m: string) => `{"privateKeyPkcs8":"${k}","blindedMessage":"${m}","blindedMessage":"${m}"}`],
    ["extra member", (k: string, m: string) => `{"privateKeyPkcs8":"${k}","blindedMessage":"${m}","x":"1"}`],
    ["missing member", (_k: string, m: string) => `{"blindedMessage":"${m}"}`],
    ["non-JSON", () => "privateKeyPkcs8"],
  ])("rejects a request with %s", async (_label, makeBody) => {
    sentMaterial.push(b64(poll.pkcs8));
    expectGenericRejection(await call(makeBody(b64(poll.pkcs8), b64(valid()))), 400);
  });

  test("rejects bodies over 16 KiB, wrong media types, methods, and paths", async () => {
    const big = JSON.stringify({ privateKeyPkcs8: "A".repeat(17_000), blindedMessage: b64(valid()) });
    expectGenericRejection(await call(big), 413);
    expectGenericRejection(await call(requestBody(poll.pkcs8, valid()), { contentType: "text/plain" }), 415);
    expectGenericRejection(await call("", { method: "GET" }), 405);
    expectGenericRejection(await call("{}", { path: "/sign" }), 404);
  });

  test("enforces the 16 KiB limit on a chunked body with no Content-Length", async () => {
    // Stream a single oversized chunk: the server can reject it without racing
    // the client's remaining writes (which otherwise surface as an EPIPE).
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("A".repeat(16 * 1024 + 1)));
        controller.close();
      },
    });
    const response = await fetch(`${url}/blind-sign`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expectGenericRejection({ status: response.status, text: await response.text() }, 413);
  });
});

describe("signer diagnostics", () => {
  test("the signer process log contains no request material", () => {
    const log = readFileSync(inject("signerLogPath"), "utf8");
    expect(sentMaterial.length).toBeGreaterThan(10);
    for (const material of sentMaterial) expect(log.includes(material)).toBe(false);
    expect(log).not.toMatch(/BEGIN (RSA )?PRIVATE KEY/);
  });
});
