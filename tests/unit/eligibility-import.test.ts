import { expect, test } from "vitest";
import { parseEligibilityImport, parseEligibilityImportWithMetadata } from "../../apps/portal/src/eligibility-import";

test("newline list and single-column RFC 4180 CSV produce complete rows without an optional email header", () => {
  expect(parseEligibilityImport("  A@iitgn.ac.in\nB@iitgn.ac.in\n")).toEqual(["  A@iitgn.ac.in", "B@iitgn.ac.in"]);
  expect(parseEligibilityImport("email\r\n\"A@iitgn.ac.in\"\r\n\"B@iitgn.ac.in\"\r\n"))
    .toEqual(["A@iitgn.ac.in", "B@iitgn.ac.in"]);
  expect(parseEligibilityImport("\"email\"\r\n\"a+tag@iitgn.ac.in\""))
    .toEqual(["a+tag@iitgn.ac.in"]);
});

test("rejects extra columns, malformed quoting, blank rows and an empty import without returning partial data", () => {
  for (const source of ["", "\n", "a@iitgn.ac.in\n\nb@iitgn.ac.in", "email,other\na@iitgn.ac.in,foo",
    "\"a@iitgn.ac.in\"junk", "\"a@iitgn.ac.in", "a@iitgn.ac.in,", " a@iitgn.ac.in\rnotvalid",
  ]) expect(() => parseEligibilityImport(source)).toThrow(/invalid import/);
});

test("row map refers to physical CSV lines including headers and quoted newlines", () => {
  expect(parseEligibilityImportWithMetadata('email\r\n"a\nb"\r\nc@iitgn.ac.in')).toEqual({
    emails:["a\nb","c@iitgn.ac.in"],sourceRows:[2,4],
  });
});

test("quoted embedded newline/escaped quote remain one field; semantic address validation is server-side", () => {
  expect(parseEligibilityImport('"a\n@iitgn.ac.in"\r\n"b""c@iitgn.ac.in"'))
    .toEqual(["a\n@iitgn.ac.in", 'b"c@iitgn.ac.in']);
});
