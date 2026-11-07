import { describe, expect, test } from "vitest";
import { assertPublicOperationMatches } from "../../services/signer/src/fault-check";
import { freshKey, nodeRawSign } from "../fixtures/rsa";

// The worker calls this after every native signature; faults can't be injected
// into the runtime, so the check itself is exercised here with tampered outputs.
describe("signer fault check (independent public operation)", () => {
  const key = freshKey();
  const n = Uint8Array.from(Buffer.from(key.jwk.n as string, "base64url"));
  const e = Uint8Array.of(1, 0, 1);
  const blinded = Uint8Array.from(Buffer.alloc(384, 7));
  const signature = nodeRawSign(key.privateKey, blinded);

  test("accepts a correct private-operation output", () => {
    expect(() => assertPublicOperationMatches(n, e, blinded, signature)).not.toThrow();
  });

  test("rejects a single flipped bit in the output", () => {
    const faulty = signature.slice();
    faulty[200] ^= 0x01;
    expect(() => assertPublicOperationMatches(n, e, blinded, faulty)).toThrow(/fault check failed|out of range/);
  });

  test("rejects a correct signature over a different input", () => {
    const other = Uint8Array.from(Buffer.alloc(384, 8));
    expect(() => assertPublicOperationMatches(n, e, other, signature)).toThrow(/fault check failed/);
  });

  test("rejects an output representative >= n", () => {
    expect(() => assertPublicOperationMatches(n, e, blinded, n)).toThrow(/out of range/);
  });
});
