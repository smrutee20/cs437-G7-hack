import { expect, test } from "vitest";
import { parseEligibilityImport, parseEligibilityImportWithMetadata } from "../../apps/portal/src/eligibility-import";

test("newline list and single-column RFC 4180 CSV produce complete rows without an optional email header", () => {
  expect(parseEligibilityImport("  A@iitgn.ac.in\nB@iitgn.ac.in\n")).toEqual(["A@iitgn.ac.in", "B@iitgn.ac.in"]);
  expect(parseEligibilityImport("email\r\n\"A@iitgn.ac.in\"\r\n\"B@iitgn.ac.in\"\r\n"))
    .toEqual(["A@iitgn.ac.in", "B@iitgn.ac.in"]);
  expect(parseEligibilityImport("\"email\"\r\n\"a+tag@iitgn.ac.in\""))
    .toEqual(["a+tag@iitgn.ac.in"]);
});

test("rejects extra columns, malformed quoting and an import with no addresses without returning partial data", () => {
  for (const source of ["", "\n", "  \n\t\r\n", "email\n\n", "email,other\na@iitgn.ac.in,foo",
    "\"a@iitgn.ac.in\"junk", "\"a@iitgn.ac.in\"  junk", "\"a@iitgn.ac.in", "a@iitgn.ac.in,", " a@iitgn.ac.in\rnotvalid",
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

test("trailing and interior blank or whitespace-only lines are skipped and line numbers stay physical", () => {
  expect(parseEligibilityImportWithMetadata("a@iitgn.ac.in\nb@iitgn.ac.in\n\n\n  \n")).toEqual({
    emails: ["a@iitgn.ac.in", "b@iitgn.ac.in"], sourceRows: [1, 2],
  });
  expect(parseEligibilityImportWithMetadata("\n  \nemail\r\n\r\na@iitgn.ac.in\r\n \t \r\nb@iitgn.ac.in\r\n\r\n")).toEqual({
    emails: ["a@iitgn.ac.in", "b@iitgn.ac.in"], sourceRows: [5, 7],
  });
});

test("padded addresses are trimmed, quoted or not, and a padded header is still recognised", () => {
  expect(parseEligibilityImportWithMetadata("  email  \n  a@iitgn.ac.in  \n\tb@iitgn.ac.in\t\n\" c@iitgn.ac.in \"")).toEqual({
    emails: ["a@iitgn.ac.in", "b@iitgn.ac.in", "c@iitgn.ac.in"], sourceRows: [2, 3, 4],
  });
});

test("spaces before an opening quote or after a closing quote are accepted", () => {
  expect(parseEligibilityImportWithMetadata("\"email\" \r\n\"a@iitgn.ac.in\"  \r\n  \"b@iitgn.ac.in\"\t\r\n\"c@iitgn.ac.in\" ")).toEqual({
    emails: ["a@iitgn.ac.in", "b@iitgn.ac.in", "c@iitgn.ac.in"], sourceRows: [2, 3, 4],
  });
});
