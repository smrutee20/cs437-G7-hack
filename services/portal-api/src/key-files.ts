import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isCanonicalUuidV4 } from "@iitgn-feedback/protocol";

/** The private-key store must be a 0700 directory owned by this process's user. */
export async function checkedDirectory(directory: string): Promise<void> {
  const dir = await lstat(directory);
  if (!dir.isDirectory() || (dir.mode & 0o777) !== 0o700 ||
      (process.getuid?.() !== undefined && dir.uid !== process.getuid())) throw new Error("key store unavailable");
}

/** Removes private key files (an already-missing file is fine) and fsyncs the directory once. */
export async function unlinkPollKeys(directory: string, refs: (string | null)[]): Promise<void> {
  const valid = refs.filter((ref): ref is string => typeof ref === "string");
  if (valid.length === 0) return;
  await checkedDirectory(directory);
  for (const ref of valid) {
    if (!isCanonicalUuidV4(ref)) throw new Error("invalid private key reference");
    try { await unlink(join(directory, ref)); }
    catch (cause) { if ((cause as { code?: string }).code !== "ENOENT") throw cause; }
  }
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await handle.sync(); } finally { await handle.close(); }
}
