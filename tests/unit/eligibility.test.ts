import { describe, expect, test } from "vitest";
import { validateEligibilityEmails } from "../../services/portal-api/src/eligibility";

const ten = Array.from({ length: 10 }, (_, i) => `student${i}@iitgn.ac.in`);

describe("draft eligibility input (SPEC.md §§2,5)", () => {
  test("normalizes ASCII whitespace and case, deduplicates only exact normalized addresses", () => {
    const result = validateEligibilityEmails([
      " \tSTUDENT0@IITGN.AC.IN\r\n", ...ten,
      "student0+tag@iitgn.ac.in", "student.0@iitgn.ac.in",
    ]);
    expect(result).toEqual({ inputCount: 13, emails: [...ten, "student0+tag@iitgn.ac.in", "student.0@iitgn.ac.in"] });
  });

  test("rejects all invalid rows together with 1-based row numbers, never their values", () => {
    const input: unknown[] = [...ten];
    input[1] = "other@example.org";
    input[6] = "bad..dots@iitgn.ac.in";
    input.push(42);
    try {
      validateEligibilityEmails(input);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_eligibility", rowNumbers: [2, 7, 11] });
      expect(JSON.stringify(error)).not.toContain("other@example.org");
      expect(JSON.stringify(error)).not.toContain("bad..dots");
    }
  });

  test.each([
    "a@iitgn.ac.in@iitgn.ac.in", ".a@iitgn.ac.in", "a.@iitgn.ac.in",
    "a..b@iitgn.ac.in", "é@iitgn.ac.in", "K@iitgn.ac.in", "a@sub.iitgn.ac.in",
    "a@iitgn.ac.in\u00a0", "a b@iitgn.ac.in", "a\n@iitgn.ac.in",
    `${"a".repeat(65)}@iitgn.ac.in`, "@iitgn.ac.in",
  ])("rejects invalid/non-ASCII address %j", (bad) => {
    expect(() => validateEligibilityEmails([...ten, bad])).toThrow(/invalid eligibility/);
  });

  test("requires 10–1,000 unique addresses, not merely 10 rows", () => {
    for (const input of [ten.slice(0, 9), Array(10).fill(ten[0]),
      Array.from({ length: 1001 }, (_, i) => `student${i}@iitgn.ac.in`)]) {
      expect(() => validateEligibilityEmails(input)).toThrow(/10 to 1000 unique/);
    }
    expect(validateEligibilityEmails(Array.from({ length: 1000 }, (_, i) => `student${i}@iitgn.ac.in`)).emails).toHaveLength(1000);
  });

  test("rejects wrong framing and does not coerce inputs", () => {
    const sparse = [...ten, "student10@iitgn.ac.in"];
    delete sparse[0];
    for (const input of [null, {}, "a@iitgn.ac.in", [ten], [...ten, null], sparse]) {
      expect(() => validateEligibilityEmails(input)).toThrow(/invalid eligibility/);
    }
  });
});
