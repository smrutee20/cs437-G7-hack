import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isCanonicalUuidV4 } from "@iitgn-feedback/protocol";
import type { Client } from "pg";
import { PollError } from "./poll-lifecycle.js";

// Database deletion and tombstone commit precede key-file removal. An ambiguous
// commit must never trigger key deletion: the DB may still refer to that key.
export async function deleteDraft(client: Client, owner: string, id: string, keyDirectory: string): Promise<void> {
  if (!isCanonicalUuidV4(id)) throw new PollError("not_found");
  const {rows}=await client.query<{state:string;key_id:string}>(
    `SELECT p.state,k.key_id FROM polls p JOIN signing_keys k ON k.poll_id=p.id
      WHERE p.id=$1 AND p.organiser_id=$2`,[id,owner],
  );
  if (!rows[0]) throw new PollError("not_found");
  if (rows[0].state!=="draft") throw new PollError("invalid_state");
  let deleted:boolean;
  try {
    const result=await client.query<{deleted:boolean}>(
      "SELECT delete_draft_poll($1,$2) AS deleted",[id,owner],
    );
    deleted=result.rows[0]?.deleted===true;
  } catch (cause) {
    if ((cause as {code?:string}).code==="23514") throw new PollError("invalid_state");
    throw cause;
  }
  if (!deleted) throw new PollError("not_found");
  const keyId=rows[0].key_id;
  if (!isCanonicalUuidV4(keyId)) throw new Error("invalid key reference");
  const dir=await lstat(keyDirectory);
  if (!dir.isDirectory() || (dir.mode & 0o777)!==0o700 ||
      (process.getuid?.()!==undefined && dir.uid!==process.getuid())) throw new Error("key store unavailable");
  try {await unlink(join(keyDirectory,keyId));}
  catch (cause) {
    if ((cause as {code?:string}).code!=="ENOENT") throw cause;
  }
  const handle=await open(keyDirectory,constants.O_RDONLY|constants.O_DIRECTORY);
  try {await handle.sync();} finally {await handle.close();}
}
