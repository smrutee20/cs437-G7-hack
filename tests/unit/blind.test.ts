import { describe, expect, test } from "vitest";
import {
  blindMessage,
  finalizeSignature,
  importPollPublicKey,
  prepareMessage,
  verifySignature,
} from "../../packages/protocol/src/blind";
import { encodeApplicationMessage, parsePreparedMessage } from "../../packages/protocol/src/credential";
import { rfc9474A1 as v } from "../fixtures/rfc9474-a1";
import { b64u, bytes, freshKey, nodeRawSign, nodeVerifyPss, rfcPrivateKey } from "../fixtures/rsa";
import type { KeyObject } from "node:crypto";

const freshPollKey = () => freshKey();

const pollId = "123e4567-e89b-42d3-a456-426614174000";

describe("RFC 9474 A.1 RSABSSA-SHA384-PSS-Randomized vector", () => {
  test("an independent native raw RSA private operation reproduces blind_sig", () => {
    expect(Buffer.from(nodeRawSign(rfcPrivateKey(), bytes(v.blinded_msg))).toString("hex")).toBe(v.blind_sig);
  });

  test("finalize(blind_sig, inv) yields sig, which verifies over prepared_msg", async () => {
    const key = await crypto.subtle.importKey(
      "jwk", { kty: "RSA", n: b64u(v.n), e: b64u(v.e) }, { name: "RSA-PSS", hash: "SHA-384" }, true, ["verify"],
    );
    const sig = await finalizeSignature(key, bytes(v.prepared_msg), bytes(v.blind_sig), bytes(v.inv));
    expect(Buffer.from(sig).toString("hex")).toBe(v.sig);
    expect(await verifySignature(key, bytes(v.prepared_msg), sig)).toBe(true);
    expect(await verifySignature(key, bytes(v.msg), sig)).toBe(false);
    expect(nodeVerifyPss(rfcPrivateKey(), bytes(v.prepared_msg), sig)).toBe(true);
  });
});

describe("client blind-signature round trip with a fresh 3072-bit poll key", () => {
  test("prepare → blind → native raw sign → finalize → verify, keeping the 32-byte prefix", async () => {
    const { privateKey, publicKey, jwk } = freshPollKey();
    const key = await importPollPublicKey(jwk);
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const prepared = prepareMessage(encodeApplicationMessage(pollId, secret));
    expect(prepared.length).toBe(111);
    const { blindedMessage, inverse } = await blindMessage(key, prepared);
    expect([blindedMessage.length, inverse.length]).toEqual([384, 384]);

    const blindSignature = nodeRawSign(privateKey, blindedMessage);
    const signature = await finalizeSignature(key, prepared, blindSignature, inverse);
    expect(signature.length).toBe(384);
    expect(await verifySignature(key, prepared, signature)).toBe(true);
    expect(nodeVerifyPss(publicKey as unknown as KeyObject, prepared, signature)).toBe(true);
    expect(parsePreparedMessage(prepared, pollId).secret).toEqual(secret);
  });

  test("each preparation uses a fresh random prefix", () => {
    const message = encodeApplicationMessage(pollId, new Uint8Array(32));
    const a = prepareMessage(message);
    const b = prepareMessage(message);
    expect(a.subarray(32)).toEqual(message);
    expect(Buffer.from(a.subarray(0, 32)).equals(Buffer.from(b.subarray(0, 32)))).toBe(false);
  });

  test("a blind signature from poll A's key does not finalize under poll B's key", async () => {
    const a = freshPollKey();
    const b = freshPollKey();
    const keyB = await importPollPublicKey(b.jwk);
    const nA = Buffer.from(a.jwk.n as string, "base64url");
    const prepared = prepareMessage(encodeApplicationMessage(pollId, new Uint8Array(32)));
    // A value blinded mod n_B is >= n_A about half the time, and A cannot sign it at
    // all. Re-blind until A can, so the finalization failure is what's exercised.
    let blinded = await blindMessage(keyB, prepared);
    for (let attempt = 0; Buffer.compare(Buffer.from(blinded.blindedMessage), nA) >= 0; attempt++) {
      expect(attempt).toBeLessThan(40);
      blinded = await blindMessage(keyB, prepared);
    }
    await expect(finalizeSignature(keyB, prepared, nodeRawSign(a.privateKey, blinded.blindedMessage), blinded.inverse))
      .rejects.toThrow(/invalid signature/);
  });

  test("rejects application messages that are not exactly 79 bytes", () => {
    expect(() => prepareMessage(new Uint8Array(78))).toThrow(/79-byte/);
    expect(() => prepareMessage(new Uint8Array(80))).toThrow(/79-byte/);
  });

  test("refuses to blind a message that is not a 111-byte prepared credential message", async () => {
    const key = await importPollPublicKey(freshPollKey().jwk);
    await expect(blindMessage(key, new Uint8Array(110))).rejects.toThrow(/111-byte/);
  });
});

describe("poll public-key import policy (SPEC.md §6)", () => {
  const good = freshPollKey().jwk;
  const small = freshKey(2048).jwk;

  test.each([
    ["a 2048-bit modulus", small],
    ["public exponent 3", { ...good, e: "Aw" }],
    ["an extra private member", { ...good, d: "AQAB" }],
    ["an alg member", { ...good, alg: "PS384" }],
    ["a non-RSA kty", { ...good, kty: "EC" }],
    ["a padded n", { ...good, n: `${good.n}=` }],
    ["a missing n", { kty: "RSA", e: "AQAB" }],
    ["a non-object", "AQAB"],
  ])("rejects %s", async (_label, jwk) => {
    await expect(importPollPublicKey(jwk)).rejects.toThrow(/poll public key/);
  });

  test("imports a canonical 3072-bit, e=65537 key for RSA-PSS SHA-384 verification only", async () => {
    const key = await importPollPublicKey(good);
    expect(key.type).toBe("public");
    expect(key.usages).toEqual(["verify"]);
    expect(key.algorithm).toMatchObject({ name: "RSA-PSS", modulusLength: 3072, hash: { name: "SHA-384" } });
  });
});
