import { expect, test } from "vitest";
import { addressStyles, mixedAddressWarning } from "../../apps/portal/src/address-styles";

test("an all-digit local part is a roll-number address; anything else is a name address", () => {
  expect(addressStyles(["22110123@iitgn.ac.in", " 22110124@IITGN.AC.IN ", "jane.doe@iitgn.ac.in", "22110125a@iitgn.ac.in"]))
    .toEqual({ rollNumber: 2, name: 2, mixed: true });
});

test("a uniform list is not mixed", () => {
  expect(addressStyles(["22110123@iitgn.ac.in", "22110124@iitgn.ac.in"])).toEqual({ rollNumber: 2, name: 0, mixed: false });
  expect(addressStyles(["jane.doe@iitgn.ac.in", "raj.k@iitgn.ac.in"])).toEqual({ rollNumber: 0, name: 2, mixed: false });
  expect(addressStyles([])).toEqual({ rollNumber: 0, name: 0, mixed: false });
});

test("the warning names both counts and explains the exact-match rule; uniform lists get none", () => {
  const text = mixedAddressWarning(["22110123@iitgn.ac.in", "jane.doe@iitgn.ac.in", "raj.k@iitgn.ac.in"])!;
  expect(text).toContain("1 roll-number address");
  expect(text).toContain("2 name addresses");
  expect(text).toMatch(/exactly/);
  expect(text).toMatch(/other address/);
  expect(mixedAddressWarning(["22110123@iitgn.ac.in", "22110124@iitgn.ac.in"])).toBeNull();
  expect(mixedAddressWarning(null)).toBeNull();
});
