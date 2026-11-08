// SPEC.md §7 human-text rule, shared by draft validation, answer validation and
// the browser: reject unpaired surrogates; CRLF/CR → LF; NFC; ECMAScript trim;
// reject Cc controls other than LF/TAB; then apply code-point and byte bounds.
const encoder = new TextEncoder();

/** Returns the normalized text, or null if it violates the rule or the bounds. */
export function normalizeHumanText(value: unknown, maxCodePoints: number, maxBytes: number, allowEmpty = false): string | null {
  if (typeof value !== "string") return null;
  // for..of yields whole scalar values for valid pairs but the surrogate code
  // point for an unpaired UTF-16 surrogate. Reject before Unicode normalization.
  for (const scalar of value) {
    const cp = scalar.codePointAt(0)!;
    if (cp >= 0xd800 && cp <= 0xdfff) return null;
  }
  const normalized = value.replace(/\r\n?/g, "\n").normalize("NFC").trim();
  if (/[\p{Cc}]/u.test(normalized.replace(/[\n\t]/g, ""))) return null;
  if (!allowEmpty && normalized.length === 0) return null;
  if ([...normalized].length > maxCodePoints || encoder.encode(normalized).length > maxBytes) return null;
  return normalized;
}
