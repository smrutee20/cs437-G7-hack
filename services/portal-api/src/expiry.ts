import type { Client } from "pg";

// Dedicated background closer, not an organiser or public request role.
// UPDATE takes an exclusive row lock, conflicting with future claim/redeem
// shared poll locks. Effective deadline remains DB-clock based even if this
// job is delayed or stopped.
export async function closeExpiredPolls(client: Client): Promise<number> {
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  try {
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '2s'");
    const changed=await client.query(
      `UPDATE polls SET state='closed',closed_at=closes_at,updated_at=clock_timestamp()
         WHERE state='open' AND clock_timestamp() >= closes_at`,
    );
    await client.query("COMMIT");
    return changed.rowCount??0;
  } catch (cause) {
    await client.query("ROLLBACK");
    throw cause;
  }
}
