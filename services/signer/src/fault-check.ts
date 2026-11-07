import { os2ip, rsavp1 } from "@cloudflare/blindrsa-ts/lib/src/util.js";

/**
 * Independent fault check on a native RSA private operation (SPEC.md §6): the
 * library's public operation RSAVP1 (which also enforces 0 <= s < n) must map the
 * signature back to the blinded input. Throws instead of releasing a bad signature.
 */
export function assertPublicOperationMatches(
  modulus: Uint8Array,
  exponent: Uint8Array,
  blinded: Uint8Array,
  signature: Uint8Array,
): void {
  const recovered = rsavp1({ n: os2ip(modulus), e: os2ip(exponent) }, os2ip(signature));
  if (!recovered.equals(os2ip(blinded))) throw new Error("fault check failed");
}
