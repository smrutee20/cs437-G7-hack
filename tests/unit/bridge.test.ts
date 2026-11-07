import { describe, expect, test } from "vitest";
import { newChannelNonce, parseBridgeMessage } from "../../packages/protocol/src/bridge";

// Expected shapes come from SPEC.md §8 "Message contract".
const pollId = "123e4567-e89b-42d3-a456-426614174000";
const keyId = "9b2f4c1e-7d3a-4e8b-a1c2-5f6e7d8c9b0a";
const nonce = Buffer.alloc(32, 7).toString("base64url");
const ready = { version: 1, type: "bridge_ready", pollId };
const init = { version: 1, type: "bridge_init", pollId, channelNonce: nonce, keyId };
const ack = { version: 1, type: "bridge_ack", pollId, channelNonce: nonce };

describe("bridge handshake message grammar", () => {
  test.each([
    ["bridge_ready", ready],
    ["bridge_init", init],
    ["bridge_ack", ack],
  ] as const)("accepts a well-formed %s when that type is expected", (type, message) => {
    expect(parseBridgeMessage(structuredClone(message), [type])).toEqual(message);
  });

  test("rejects a well-formed message whose type is not expected in the current state", () => {
    expect(() => parseBridgeMessage(ack, ["bridge_ready"])).toThrow(/invalid bridge message/);
    expect(() => parseBridgeMessage(init, ["bridge_ack"])).toThrow(/invalid bridge message/);
  });

  test.each([
    ["version 2", { ...ready, version: 2 }],
    ["string version", { ...ready, version: "1" }],
    ["unknown type", { ...ready, type: "claim_result" }],
    ["extra field", { ...ready, email: "a@iitgn.ac.in" }],
    ["missing pollId", { version: 1, type: "bridge_ready" }],
    ["uppercase pollId", { ...ready, pollId: pollId.toUpperCase() }],
    ["non-v4 pollId", { ...ready, pollId: "123e4567-e89b-12d3-a456-426614174000" }],
  ])("rejects a bridge_ready with %s", (_label, message) => {
    expect(() => parseBridgeMessage(message, ["bridge_ready", "bridge_init", "bridge_ack"])).toThrow(/invalid bridge message/);
  });

  test.each([
    ["31-byte nonce", { ...init, channelNonce: Buffer.alloc(31, 7).toString("base64url") }],
    ["33-byte nonce", { ...init, channelNonce: Buffer.alloc(33, 7).toString("base64url") }],
    ["padded nonce", { ...init, channelNonce: `${Buffer.alloc(32, 7).toString("base64")}` }],
    ["missing keyId", { version: 1, type: "bridge_init", pollId, channelNonce: nonce }],
    ["non-canonical keyId", { ...init, keyId: keyId.replaceAll("-", "") }],
    ["numeric nonce", { ...init, channelNonce: 7 }],
  ])("rejects a bridge_init with %s", (_label, message) => {
    expect(() => parseBridgeMessage(message, ["bridge_init"])).toThrow(/invalid bridge message/);
  });

  test("rejects an ack carrying any extra data", () => {
    expect(() => parseBridgeMessage({ ...ack, keyId }, ["bridge_ack"])).toThrow(/invalid bridge message/);
  });

  test.each([
    ["null", null],
    ["a JSON string", JSON.stringify(ready)],
    ["an array", [ready]],
    ["a Date", new Date()],
    ["a Map", new Map(Object.entries(ready))],
    ["an object with a non-plain prototype", Object.assign(Object.create({ inherited: true }), ready)],
  ])("rejects %s", (_label, data) => {
    expect(() => parseBridgeMessage(data, ["bridge_ready"])).toThrow(/invalid bridge message/);
  });

  test("rejects messages over 2 KiB before inspecting fields", () => {
    const big = { ...ready, padding: "x".repeat(3000) };
    expect(() => parseBridgeMessage(big, ["bridge_ready"])).toThrow(/invalid bridge message/);
  });
});

describe("channel nonce", () => {
  test("is 32 fresh random bytes as canonical unpadded base64url", () => {
    const a = newChannelNonce();
    const b = newChannelNonce();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(a, "base64url").length).toBe(32);
    expect(Buffer.from(a, "base64url").toString("base64url")).toBe(a);
    expect(a).not.toBe(b);
  });
});
