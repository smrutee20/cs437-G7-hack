// Owner-only gated results (SPEC.md §11). All aggregation happens inside the
// owner-gated database function; this code never reads responses.
import type { Client } from "pg";
import { isCanonicalUuidV4 } from "@iitgn-feedback/protocol";

export type ResultsOutcome =
  | { outcome: "not_found" | "results_not_closed" | "poll_withdrawn" }
  | { outcome: "ready"; result: unknown };

export async function readResults(client: Client, owner: string, pollId: string): Promise<ResultsOutcome> {
  if (!isCanonicalUuidV4(pollId)) return { outcome: "not_found" };
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  try {
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const { rows } = await client.query<{ outcome: string; result: unknown }>(
      "SELECT outcome, result FROM anonymous.publish_results($1, $2)", [pollId, owner]);
    await client.query("COMMIT");
    const { outcome, result } = rows[0];
    if (outcome === "ready") return { outcome, result };
    if (outcome === "not_found" || outcome === "results_not_closed" || outcome === "poll_withdrawn") return { outcome };
    throw new Error("unexpected results outcome");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}
