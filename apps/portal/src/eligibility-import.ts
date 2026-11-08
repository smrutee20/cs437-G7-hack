// Paste/CSV parser. Server revalidates the resulting email array independently.
// Accepts LF newline lists and single-column RFC 4180 quoting/CRLF; no uploads.
export function parseEligibilityImportWithMetadata(source: string): { emails: string[]; sourceRows: number[] } {
  const invalid = (): never => { throw new Error("invalid import"); };
  if (typeof source !== "string" || source.length === 0 || source.length > 256 * 1024) invalid();
  const rows: string[] = [];
  const sourceRows: number[] = [];
  let physicalLine = 1, rowStart = 1;
  let value = "";
  let state: "start" | "plain" | "quoted" | "after_quote" = "start";
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (state === "quoted") {
      if (char === '"') {
        if (source[index + 1] === '"') { value += '"'; index++; }
        else state = "after_quote";
      } else {
        value += char;
        if (char === "\n") physicalLine++;
      }
      continue;
    }
    if (char === ',') invalid(); // extra column in a single-column import
    if (char === "\n" || char === "\r") {
      if (char === "\r") {
        if (source[index + 1] !== "\n") invalid();
        index++;
      }
      if (!value.trim()) invalid();
      rows.push(value);
      sourceRows.push(rowStart);
      physicalLine++;
      rowStart = physicalLine;
      value = "";
      state = "start";
      continue;
    }
    if (state === "after_quote") invalid();
    if (char === '"') {
      if (state !== "start") invalid();
      state = "quoted";
    } else {
      value += char;
      state = "plain";
    }
  }
  if (state === "quoted") invalid();
  if (value) {
    if (!value.trim()) invalid();
    rows.push(value);
    sourceRows.push(rowStart);
  } else if (state !== "start" || rows.length === 0) invalid();
  if (rows[0]?.trim().toLowerCase() === "email") { rows.shift(); sourceRows.shift(); }
  if (rows.length === 0) invalid();
  return { emails: rows, sourceRows };
}

export function parseEligibilityImport(source: string): string[] {
  return parseEligibilityImportWithMetadata(source).emails;
}
