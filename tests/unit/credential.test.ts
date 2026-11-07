import { describe, expect, test } from "vitest";
import {
  computeNullifier,
  decodeBase64Url,
  decodeBase64UrlUpTo,
  encodeApplicationMessage,
  encodeBase64Url,
  parsePreparedMessage,
} from "../../packages/protocol/src/credential";

const pollId = "123e4567-e89b-42d3-a456-426614174000";
const otherPollId = "9b2f4c1e-7d3a-4e8b-a1c2-5f6e7d8c9b0a";
const secret = Uint8Array.from({ length: 32 }, (_, index) => index);

// Constants are copied from SPEC.md §7, not calculated with production helpers.
const messageHex = "494954474e2d464545444241434b2d43524544454e5449414c0001123e4567e89b42d3a45642661417400000000001000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const nullifierHex = "5b42afa082f7f1fdcd75b36ffe14923fe7a9759a8971e8223b3d1e2c300d973c";
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

function prepared(message: Uint8Array = Buffer.from(messageHex, "hex")): Uint8Array {
  const out = new Uint8Array(32 + message.length);
  out.set(Uint8Array.from({ length: 32 }, (_, index) => 255 - index));
  out.set(message, 32);
  return out;
}

describe("application message and nullifier (SPEC.md §7)", () => {
  test("match the published byte fixture and lengths", async () => {
    const message = encodeApplicationMessage(pollId, secret);
    expect(message.length).toBe(79);
    expect(hex(message)).toBe(messageHex);
    expect(hex(await computeNullifier(pollId, secret))).toBe(nullifierHex);
  });

  test("nullifier ignores the preparation prefix: it depends only on poll and secret", async () => {
    expect(hex(await computeNullifier(otherPollId, secret))).not.toBe(nullifierHex);
    const otherSecret = secret.map((byte) => byte ^ 0xff);
    expect(hex(await computeNullifier(pollId, otherSecret))).not.toBe(nullifierHex);
  });

  test.each([
    ["uppercase", "123E4567-E89B-42D3-A456-426614174000"],
    ["UUIDv1", "123e4567-e89b-12d3-a456-426614174000"],
    ["non-RFC variant", "123e4567-e89b-42d3-c456-426614174000"],
    ["no hyphens", "123e4567e89b42d3a456426614174000"],
    ["braces", "{123e4567-e89b-42d3-a456-426614174000}"],
  ])("rejects a %s poll ID", (_label, badPoll) => {
    expect(() => encodeApplicationMessage(badPoll, secret)).toThrow(/canonical UUIDv4/);
  });

  test.each([31, 33, 0])("rejects a %i-byte secret", async (length) => {
    expect(() => encodeApplicationMessage(pollId, new Uint8Array(length))).toThrow(/exactly 32 bytes/);
    await expect(computeNullifier(pollId, new Uint8Array(length))).rejects.toThrow(/exactly 32 bytes/);
  });
});

describe("prepared message grammar", () => {
  test("parses a 111-byte prepared message without altering its random prefix", () => {
    const input = prepared();
    const before = input.slice();
    expect(parsePreparedMessage(input, pollId)).toEqual({ pollId, keyVersion: 1, secret });
    expect(input).toEqual(before);
  });

  test.each([110, 112])("rejects a %i-byte prepared message", (length) => {
    const input = new Uint8Array(length);
    input.set(prepared().subarray(0, Math.min(length, 111)));
    expect(() => parsePreparedMessage(input, pollId)).toThrow(/invalid credential message/);
  });

  // Offsets within the 79-byte application message: tag 0..25, version 26,
  // poll 27..42, key version 43..46, secret 47..78.
  test.each([
    ["tag", 0],
    ["tag terminator", 25],
    ["protocol version", 26],
    ["poll ID", 27],
    ["key version (high byte)", 43],
    ["key version (low byte)", 46],
  ])("rejects a changed %s byte", (_label, offset) => {
    const message = Buffer.from(messageHex, "hex");
    message[offset] ^= 0x02;
    expect(() => parsePreparedMessage(prepared(message), pollId)).toThrow(/invalid credential message/);
  });

  test("rejects a well-formed message for a different poll", () => {
    expect(() => parsePreparedMessage(prepared(), otherPollId)).toThrow(/invalid credential message/);
  });
});

describe("canonical unpadded base64url (SPEC.md §7 wire rules)", () => {
  test("encodes and decodes like RFC 4648 base64url for every byte value and length remainder", () => {
    const all = Uint8Array.from({ length: 256 }, (_, index) => index);
    for (const length of [0, 1, 2, 3, 4, 32, 111, 256]) {
      const bytes = all.subarray(0, length);
      const expected = Buffer.from(bytes).toString("base64url");
      expect(encodeBase64Url(bytes)).toBe(expected);
      expect(decodeBase64Url(expected, length)).toEqual(Uint8Array.from(bytes));
    }
  });

  test("rejects non-canonical trailing bits, padding, and wrong lengths", () => {
    expect(encodeBase64Url(Uint8Array.of(0xff))).toBe("_w");
    expect(decodeBase64Url("_w", 1)).toEqual(Uint8Array.of(0xff));
    expect(() => decodeBase64Url("_x", 1)).toThrow(/invalid base64url/);
    expect(() => decodeBase64Url("_w=", 1)).toThrow(/invalid base64url/);
    expect(() => decodeBase64Url("_w", 2)).toThrow(/invalid base64url/);
    expect(() => decodeBase64Url("_w", 0)).toThrow(/invalid base64url/);
  });

  test.each([
    ["standard alphabet +", "+w"],
    ["standard alphabet /", "/w"],
    ["leading whitespace", " _w"],
    ["internal newline", "_\nw"],
    ["impossible length", "_"],
    ["non-ASCII", "_ŵ"],
  ])("rejects %s", (_label, text) => {
    expect(() => decodeBase64Url(text, 1)).toThrow(/invalid base64url/);
  });

  test("rejects non-string input", () => {
    expect(() => decodeBase64Url(42 as unknown as string, 1)).toThrow(/invalid base64url/);
  });

  test("bounded decoding accepts any canonical length up to the limit and nothing above it", () => {
    const bytes = Uint8Array.from({ length: 64 }, (_, index) => index * 3);
    for (const length of [1, 2, 3, 63, 64]) {
      const text = Buffer.from(bytes.subarray(0, length)).toString("base64url");
      expect(decodeBase64UrlUpTo(text, 64)).toEqual(bytes.subarray(0, length));
    }
    expect(() => decodeBase64UrlUpTo(Buffer.from(new Uint8Array(65)).toString("base64url"), 64)).toThrow(/invalid base64url/);
    expect(() => decodeBase64UrlUpTo("", 64)).toThrow(/invalid base64url/);
    expect(() => decodeBase64UrlUpTo("_x", 64)).toThrow(/invalid base64url/);
    expect(() => decodeBase64UrlUpTo("_w==", 64)).toThrow(/invalid base64url/);
    expect(() => decodeBase64UrlUpTo("A".repeat(10_000), 64)).toThrow(/invalid base64url/);
  });
});
