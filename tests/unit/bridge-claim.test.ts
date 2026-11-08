// SPEC.md §8 message contract, steps 3–5: claim_request, claim_result, stored_ack.
import { describe, expect, test } from "vitest";
import { parseBridgeMessage } from "../../packages/protocol/src/bridge";
import { claimErrorEffect } from "../../apps/respond/src/claim-policy";

const pollId = "3f0b6c1e-2a4d-4c8e-9f1a-7b2d5e6c8a90";
const keyId = "c4a1e2f3-5b6d-4e7f-8a9b-0c1d2e3f4a5b";
const nonce = Buffer.alloc(32, 7).toString("base64url");
const bytes384 = Buffer.alloc(384, 3).toString("base64url");
const request = { version: 1, type: "claim_request", pollId, channelNonce: nonce, keyId, keyVersion: 1, blindedMessage: bytes384 };
const signed = { version: 1, type: "claim_result", pollId, channelNonce: nonce, blindSignature: bytes384 };
const failed = { version: 1, type: "claim_result", pollId, channelNonce: nonce, error: "not_eligible" };
const ack = { version: 1, type: "stored_ack", pollId, channelNonce: nonce };
const parse = (data: unknown, allowed = ["claim_request", "claim_result", "stored_ack"] as const) =>
  parseBridgeMessage(data, allowed);

describe("claim messages", () => {
  test("accepts exactly the documented shapes", () => {
    expect(parse(request)).toEqual(request);
    expect(parse(signed)).toEqual(signed);
    expect(parse(failed)).toEqual(failed);
    expect(parse(ack)).toEqual(ack);
    for (const code of ["not_attempted", "login_required", "claim_consumed", "claim_consumed_no_credential",
      "temporarily_unavailable", "poll_closed", "rate_limited"]) {
      expect(parse({ ...failed, error: code })).toMatchObject({ error: code });
    }
  });

  test.each([
    ["key version 2", { ...request, keyVersion: 2 }],
    ["string key version", { ...request, keyVersion: "1" }],
    ["missing blinded message", { ...request, blindedMessage: undefined }],
    ["383-byte blinded message", { ...request, blindedMessage: Buffer.alloc(383, 3).toString("base64url") }],
    ["padded blinded message", { ...request, blindedMessage: `${bytes384}==` }],
    ["non-UUID key", { ...request, keyId: "not-a-key" }],
    ["short nonce", { ...request, channelNonce: "AAAA" }],
    ["extra field on request", { ...request, email: "someone@iitgn.ac.in" }],
    ["signature and error together", { ...signed, error: "not_eligible" }],
    ["result with neither", { version: 1, type: "claim_result", pollId, channelNonce: nonce }],
    ["unknown error code", { ...failed, error: "stack trace here" }],
    ["383-byte signature", { ...signed, blindSignature: Buffer.alloc(383, 3).toString("base64url") }],
    ["extra field on ack", { ...ack, blindSignature: bytes384 }],
    ["ack without nonce", { version: 1, type: "stored_ack", pollId }],
  ])("rejects %s", (_name, message) => {
    expect(() => parse(message)).toThrow("invalid bridge message");
  });

  test("a message type is accepted only where the caller's state allows it", () => {
    expect(() => parseBridgeMessage(request, ["bridge_init"])).toThrow("invalid bridge message");
    expect(() => parseBridgeMessage(signed, ["claim_request"])).toThrow("invalid bridge message");
    expect(() => parseBridgeMessage(ack, ["claim_result"])).toThrow("invalid bridge message");
  });
});

describe("response-side effect of a claim error (SPEC.md §8)", () => {
  test("definitive pre-insert rejections permit an explicit retry from the prepared state", () => {
    for (const code of ["not_attempted", "login_required", "csrf_failed", "forbidden", "invalid_request",
      "not_eligible", "rate_limited", "capacity_unavailable"] as const) {
      expect([code, claimErrorEffect(code)]).toEqual([code, "retry"]);
    }
  });
  test("a consumed claim is terminal, closure erases, and only uncertainty keeps claim_sent", () => {
    expect(claimErrorEffect("claim_consumed")).toBe("consumed");
    expect(claimErrorEffect("claim_consumed_no_credential")).toBe("consumed");
    expect(claimErrorEffect("poll_closed")).toBe("closed");
    expect(claimErrorEffect("poll_withdrawn")).toBe("closed");
    expect(claimErrorEffect("not_found")).toBe("closed");
    expect(claimErrorEffect("temporarily_unavailable")).toBe("uncertain");
  });
});
