// Eligibility is an exact address match, and many IITGN students have both a
// roll-number address (all-digit local part) and a name address. A list that
// mixes the two styles suggests some students may be listed under the address
// they will not sign in with (issue #5). Addresses are never mapped here.
export type AddressStyles = { rollNumber: number; name: number; mixed: boolean };

export function addressStyles(emails: readonly string[]): AddressStyles {
  let rollNumber = 0, name = 0;
  for (const email of emails) {
    const trimmed = email.trim();
    const local = trimmed.slice(0, Math.max(0, trimmed.lastIndexOf("@")));
    if (/^\d+$/.test(local)) rollNumber++; else name++;
  }
  return { rollNumber, name, mixed: rollNumber > 0 && name > 0 };
}

const count = (n: number, kind: string) => `${n} ${kind} address${n === 1 ? "" : "es"}`;

/** Warning for the open confirmation, or null when the list uses one style (or is unavailable). */
export function mixedAddressWarning(emails: readonly string[] | null): string | null {
  if (!emails) return null;
  const styles = addressStyles(emails);
  if (!styles.mixed) return null;
  return `This list mixes ${count(styles.rollNumber, "roll-number")} (like 22110123@iitgn.ac.in) and ` +
    `${count(styles.name, "name")} (like firstname.lastname@iitgn.ac.in). Eligibility matches addresses exactly: ` +
    "a student listed under one of their addresses is refused if they sign in with their other address. " +
    "Check that each student is listed under the address they will sign in with. The list cannot be changed after opening.";
}
