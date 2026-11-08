import { visit } from "jsonc-parser";

/** Reject duplicate JSON member names at any depth, including escaped spellings. */
export function parseStrictJson(bytes: Buffer): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const objects: Set<string>[] = [];
  let invalid = false;
  visit(text, {
    onObjectBegin: () => { objects.push(new Set()); },
    onObjectProperty: (key) => {
      const members = objects.at(-1);
      if (!members || members.has(key)) invalid = true;
      members?.add(key);
    },
    onObjectEnd: () => { objects.pop(); },
    onError: () => { invalid = true; },
  }, { disallowComments: true, allowTrailingComma: false });
  if (invalid) throw new Error("invalid JSON");
  return JSON.parse(text) as unknown; // strict grammar, not JSONC
}
