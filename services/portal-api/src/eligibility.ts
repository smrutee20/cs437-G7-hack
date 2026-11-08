// Server-side validation for the DraftInput eligibilityEmails array. Never include
// an address in an error: invalid row numbers are sufficient for the editor.
export class EligibilityError extends Error {
  readonly code = "invalid_eligibility";

  constructor(message: string, readonly rowNumbers: number[] = []) {
    super(message);
  }
}

const ADDRESS = /^(?!\.)(?!.*\.\.)(?!.*\.@)[a-z0-9._+-]{1,64}@iitgn\.ac\.in$/;
const ASCII_WHITESPACE = /^[\x09-\x0d\x20]+|[\x09-\x0d\x20]+$/g;

export function validateEligibilityEmails(input: unknown): { inputCount: number; emails: string[] } {
  if (!Array.isArray(input)) throw new EligibilityError("invalid eligibility input");
  const invalidRows: number[] = [];
  const emails = new Set<string>();
  for (let index = 0; index < input.length; index++) {
    const value: unknown = input[index];
    if (typeof value !== "string") {
      invalidRows.push(index + 1);
      continue;
    }
    const trimmed = value.replace(ASCII_WHITESPACE, "");
    // Check before case folding: e.g. Unicode Kelvin sign lowercases to ASCII k.
    if (/[^\x00-\x7f]/.test(trimmed)) {
      invalidRows.push(index + 1);
      continue;
    }
    const email = trimmed.toLowerCase();
    if (!ADDRESS.test(email) || Buffer.byteLength(email, "utf8") > 254) {
      invalidRows.push(index + 1);
    } else {
      emails.add(email);
    }
  }
  if (invalidRows.length) throw new EligibilityError("invalid eligibility rows", invalidRows);
  if (emails.size < 10 || emails.size > 1000) {
    throw new EligibilityError("eligibility requires 10 to 1000 unique addresses");
  }
  return { inputCount: input.length, emails: [...emails] };
}
