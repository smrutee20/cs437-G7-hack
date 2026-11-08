// SPEC.md §9 issuance: check, reserve, consume durably, then sign exactly once.
// `client` must be a dedicated feedback_issuer connection, never shared across
// concurrent requests. Nothing here persists or logs the blinded request or the
// blind signature.
import { constants, createPublicKey, publicEncrypt, timingSafeEqual } from "node:crypto";
import type { Client } from "pg";
import { decodeBase64Url, encodeBase64Url, isCanonicalUuidV4 } from "@iitgn-feedback/protocol";

const MODULUS_BYTES = 384;

export type ClaimErrorCode = "invalid_request"|"not_found"|"poll_closed"|"poll_withdrawn"|"not_eligible"|
  "claim_consumed"|"capacity_unavailable"|"claim_consumed_no_credential"|"temporarily_unavailable";
export class ClaimError extends Error {
  constructor(readonly code: ClaimErrorCode) {
    super(code);
  }
}
export type ClaimDependencies = {
  /** Checks signer health and reserves bounded signing capacity; resolves to its release. */
  reserve: () => Promise<() => void>;
  /** Decrypted private PKCS#8 DER. The caller wipes the buffer after use. */
  loadKey: (ref: string) => Promise<Buffer>;
  /** One native signer call; no automatic retries. */
  sign: (key: Buffer, blinded: Uint8Array) => Promise<Uint8Array>;
};
type PublicJwk = { kty: "RSA"; n: string; e: "AQAB" };

const DB_OUTCOMES = new Set(["claimed", "not_found", "poll_closed", "poll_withdrawn", "not_eligible", "claim_consumed"]);

function parseRequest(body: unknown): { keyId: string; blinded: Buffer } {
  const invalid = new ClaimError("invalid_request");
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid;
  const record = body as Record<string, unknown>;
  if (Object.keys(record).sort().join() !== "blindedMessage,keyId,keyVersion") throw invalid;
  if (!isCanonicalUuidV4(record.keyId) || record.keyVersion !== 1 || typeof record.blindedMessage !== "string") {
    throw invalid;
  }
  try {
    return { keyId: record.keyId, blinded: Buffer.from(decodeBase64Url(record.blindedMessage, MODULUS_BYTES)) };
  } catch {
    throw invalid;
  }
}

/** Independent public-operation check: s^e mod n must equal the blinded input. */
function verifiesUnder(jwk: PublicJwk, signature: Uint8Array, blinded: Buffer): boolean {
  if (!(signature instanceof Uint8Array) || signature.length !== MODULUS_BYTES) return false;
  try {
    const key = createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" });
    const recovered = publicEncrypt({ key, padding: constants.RSA_NO_PADDING }, signature);
    return recovered.length === blinded.length && timingSafeEqual(recovered, blinded);
  } catch {
    return false;
  }
}

/** Steps 2–3. Resolves only after a definitely successful durable commit. */
async function consume(client: Client, userId: string, email: string, pollId: string, keyId: string): Promise<void> {
  let outcome: unknown;
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query("SET LOCAL synchronous_commit = on");
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '2s'");
    const { rows } = await client.query<{ outcome: string }>(
      "SELECT identity.claim_entitlement($1,$2,$3,$4) AS outcome", [pollId, userId, email, keyId],
    );
    outcome = rows[0]?.outcome;
  } catch {
    // COMMIT was never sent, so the server cannot have committed this claim.
    await client.query("ROLLBACK").catch(() => {});
    throw new ClaimError("capacity_unavailable");
  }
  if (outcome !== "claimed") {
    await client.query("ROLLBACK").catch(() => {});
    throw new ClaimError(typeof outcome === "string" && DB_OUTCOMES.has(outcome)
      ? outcome as ClaimErrorCode : "capacity_unavailable");
  }
  try {
    await client.query("COMMIT");
  } catch {
    // Ambiguous: the claim may be durable. Never sign, never delete it as compensation.
    throw new ClaimError("temporarily_unavailable");
  }
}

export async function issueClaim(client: Client, session: { id: string; email: string }, pollId: string,
  body: unknown, deps: ClaimDependencies): Promise<{ blindSignature: string }> {
  // Step 1: framing, poll state, key binding and range, before any key or signer work.
  const request = parseRequest(body);
  if (!isCanonicalUuidV4(pollId)) throw new ClaimError("not_found");
  type Row = {
    state: string; invalidated: boolean; expired: boolean; key_id: string; key_version: number;
    public_jwk: PublicJwk; private_secret_ref: string;
  };
  let poll: Row | undefined;
  try {
    // Unlocked preflight; the locked check in claim_entitlement is authoritative.
    poll = (await client.query<Row>(
      `SELECT p.state, p.invalidated, clock_timestamp() >= p.closes_at AS expired,
              k.key_id, k.key_version, k.public_jwk, k.private_secret_ref
         FROM polls p JOIN signing_keys k ON k.poll_id = p.id WHERE p.id = $1`, [pollId],
    )).rows[0];
  } catch {
    throw new ClaimError("capacity_unavailable");
  }
  if (!poll || poll.state === "draft") throw new ClaimError("not_found");
  if (poll.invalidated) throw new ClaimError("poll_withdrawn");
  if (poll.state !== "open" || poll.expired) throw new ClaimError("poll_closed");
  if (request.keyId !== poll.key_id || poll.key_version !== 1) throw new ClaimError("invalid_request");
  const modulus = Buffer.from(poll.public_jwk.n, "base64url");
  if (modulus.length !== MODULUS_BYTES || !request.blinded.some((byte) => byte !== 0) ||
      Buffer.compare(request.blinded, modulus) >= 0) throw new ClaimError("invalid_request");

  let release: (() => void) | undefined;
  let key: Buffer | undefined;
  try {
    try {
      release = await deps.reserve();
      key = await deps.loadKey(poll.private_secret_ref);
    } catch {
      throw new ClaimError("capacity_unavailable");
    }
    await consume(client, session.id, session.email, pollId, poll.key_id);
    // Step 4: committed. One signer call; release only a result that verifies.
    let signature: Uint8Array;
    try {
      signature = await deps.sign(key, request.blinded);
    } catch {
      throw new ClaimError("claim_consumed_no_credential");
    }
    if (!verifiesUnder(poll.public_jwk, signature, request.blinded)) {
      throw new ClaimError("claim_consumed_no_credential");
    }
    return { blindSignature: encodeBase64Url(signature) };
  } finally {
    key?.fill(0);
    release?.();
  }
}
