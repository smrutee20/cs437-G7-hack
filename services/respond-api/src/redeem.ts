// SPEC.md §10 redemption. `client` is a dedicated feedback_response_public
// connection. Signature verification and answer validation happen outside the
// transaction; the locked decision is anonymous.redeem. Nothing here logs or
// persists the credential, signature, raw body or request metadata.
import type { Client } from "pg";
import {
  canonicalizeAnswers, computeNullifier, decodeBase64Url, importPollPublicKey, isCanonicalUuidV4, parsePreparedMessage,
  verifySignature,
} from "@iitgn-feedback/protocol";

export type RedeemErrorCode = "invalid_request" | "invalid_credential" | "not_found" | "validation_failed" |
  "credential_spent" | "poll_closed" | "poll_withdrawn" | "temporarily_unavailable";
export class RedeemError extends Error {
  constructor(readonly code: RedeemErrorCode, readonly field?: string) { super(code); }
}
type PublicRow = { state: string; invalidated: boolean; questions: never[]; key_id: string; key_version: number; public_jwk: unknown };

const exactKeys = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join() === [...keys].sort().join();

function parseBody(body: unknown) {
  if (!exactKeys(body, ["credential", "answers"])) throw new RedeemError("invalid_request");
  const credential = body.credential;
  if (!exactKeys(credential, ["version", "keyId", "keyVersion", "preparedMessage", "signature"]) || credential.version !== 1 ||
      typeof credential.keyId !== "string" || typeof credential.keyVersion !== "number") throw new RedeemError("invalid_request");
  try {
    return {
      keyId: credential.keyId, keyVersion: credential.keyVersion, answers: body.answers,
      prepared: decodeBase64Url(credential.preparedMessage as string, 111),
      signature: decodeBase64Url(credential.signature as string, 384),
    };
  } catch {
    throw new RedeemError("invalid_request");
  }
}

async function decide(client: Client, pollId: string, nullifier: Uint8Array, answers: unknown): Promise<string> {
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query("SET LOCAL synchronous_commit = on");
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '2s'");
    const { rows } = await client.query<{ outcome: string }>("SELECT anonymous.redeem($1, $2, $3::jsonb) AS outcome",
      [pollId, Buffer.from(nullifier), JSON.stringify(answers)]);
    const outcome = rows[0]?.outcome;
    if (outcome !== "inserted") {
      await client.query("ROLLBACK");
      return outcome ?? "temporarily_unavailable";
    }
  } catch {
    await client.query("ROLLBACK").catch(() => {});
    return "temporarily_unavailable"; // retryable: the client resends the same saved payload
  }
  try {
    await client.query("COMMIT");
    return "inserted";
  } catch {
    return "temporarily_unavailable"; // the insert may be durable; a retry will confirm it
  }
}

export async function redeemResponse(client: Client, pollId: string, body: unknown): Promise<{ status: 200 | 201 }> {
  // 1. Framing, then the poll's expected key, signature, and message grammar.
  const request = parseBody(body);
  if (!isCanonicalUuidV4(pollId)) throw new RedeemError("not_found");
  let poll: PublicRow | undefined;
  try {
    poll = (await client.query<PublicRow>(
      "SELECT state, invalidated, questions, key_id, key_version, public_jwk FROM public_polls WHERE id = $1", [pollId],
    )).rows[0];
  } catch {
    throw new RedeemError("temporarily_unavailable");
  }
  if (!poll) throw new RedeemError("not_found");
  if (poll.invalidated) throw new RedeemError("poll_withdrawn");
  if (request.keyId !== poll.key_id || request.keyVersion !== 1 || poll.key_version !== 1) throw new RedeemError("invalid_credential");
  let nullifier: Uint8Array;
  try {
    const key = await importPollPublicKey(poll.public_jwk);
    if (!(await verifySignature(key, request.prepared, request.signature))) throw new Error();
    const { secret } = parsePreparedMessage(request.prepared, pollId); // only after verification
    nullifier = await computeNullifier(pollId, secret);
    secret.fill(0);
  } catch {
    throw new RedeemError("invalid_credential");
  }
  // 2. Frozen-schema answers; a validation failure does not touch the database.
  const canonical = canonicalizeAnswers(poll.questions, request.answers);
  if (!canonical.ok) throw new RedeemError("validation_failed", canonical.field);
  // 3–5. Locked decision and durable commit.
  const outcome = await decide(client, pollId, nullifier, canonical.answers);
  if (outcome === "inserted") return { status: 201 };
  if (outcome === "replayed") return { status: 200 };
  if (outcome === "credential_spent" || outcome === "poll_closed" || outcome === "poll_withdrawn" || outcome === "not_found") {
    throw new RedeemError(outcome);
  }
  throw new RedeemError("temporarily_unavailable");
}
