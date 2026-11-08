import { constants } from "node:fs";
import { lstat, open, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isCanonicalUuidV4 } from "@iitgn-feedback/protocol";
import type { Client } from "pg";

const MIN_AGE_MS = 24 * 60 * 60 * 1000;
// Background-only job, never callable from an organiser/participant route.
// The 24h quarantine is much longer than the 10s create-request budget: it
// prevents cleanup racing a key written before its poll row is committed.
export async function sweepOrphanedKeys(client: Client, directory: string, now: Date): Promise<number> {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("invalid sweep clock");
  const dir = await lstat(directory);
  if (!dir.isDirectory() || (dir.mode & 0o777) !== 0o700 ||
      (process.getuid?.() !== undefined && dir.uid !== process.getuid())) throw new Error("key store unavailable");
  let removed = 0;
  for (const entry of await readdir(directory,{withFileTypes:true})) {
    if (removed >= 100) break;
    if (!entry.isFile() || !isCanonicalUuidV4(entry.name)) continue;
    const path=join(directory,entry.name);
    const info=await lstat(path);
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 ||
        (process.getuid?.() !== undefined && info.uid !== process.getuid())) throw new Error("key store unavailable");
    if (now.getTime()-info.mtimeMs < MIN_AGE_MS) continue;
    const {rows}=await client.query("SELECT key_id FROM signing_keys WHERE key_id=$1",[entry.name]);
    if (rows.length !== 0) continue;
    await unlink(path);
    removed++;
  }
  if (removed > 0) {
    const handle=await open(directory,constants.O_RDONLY|constants.O_DIRECTORY);
    try {await handle.sync();} finally {await handle.close();}
  }
  return removed;
}
