// Response-origin submission (SPEC.md §8 "Cleanup and confirmation", §10).
// The exact canonical payload is saved before the first attempt and reused for
// every retry. Retries are explicit; nothing resends automatically.
import { encodeBase64Url, type CanonicalAnswer } from "@iitgn-feedback/protocol";
import {
  marker, readRecord, StateConflict, transition, type SubmitPendingRecord, type UsableRecord,
} from "./credential-store";

export type SubmitOutcome =
  | { kind: "accepted" } | { kind: "spent" } | { kind: "closed" } | { kind: "invalid_credential" }
  | { kind: "edit"; field?: string } | { kind: "retry_later" } | { kind: "uncertain" };

/** Freezes the answers with the credential. Fails unless the credential is still usable. */
export function beginSubmission(pollId: string, answers: CanonicalAnswer[]): Promise<SubmitPendingRecord> {
  return transition(pollId, ["usable"], (current): SubmitPendingRecord => {
    const { draft: _draft, ...usable } = current as UsableRecord; // the frozen canonical answers replace the draft
    return { ...usable, state: "submit_pending", answers, uncertain: false };
  });
}

const payloadOf = (record: SubmitPendingRecord) => JSON.stringify({
  credential: { version: 1, keyId: record.keyId, keyVersion: 1,
    preparedMessage: encodeBase64Url(record.prepared), signature: encodeBase64Url(record.signature) },
  answers: record.answers,
});

const backToUsable = (current: SubmitPendingRecord): UsableRecord => {
  const { answers: _answers, uncertain: _uncertain, ...rest } = current;
  return { ...rest, state: "usable" };
};

/** One attempt with the saved payload. The browser never adds cookies or identity. */
export async function sendSubmission(pollId: string): Promise<SubmitOutcome> {
  const saved = await readRecord(pollId);
  if (saved?.state !== "submit_pending") throw new StateConflict(saved);
  let response: Response;
  try {
    response = await fetch(`/api/v1/polls/${pollId}/responses`, {
      method: "POST", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" }, body: payloadOf(saved),
    });
  } catch {
    return markUncertain(pollId); // the request may have reached the server
  }
  let reply: { status?: unknown; error?: { code?: unknown; field?: unknown } } | null = null;
  try { reply = await response.json(); } catch { /* not JSON */ }
  const code = reply?.error?.code;
  const apply = (next: (current: SubmitPendingRecord) => ReturnType<typeof marker> | UsableRecord | SubmitPendingRecord | null) =>
    transition(pollId, ["submit_pending"], (current) => next(current as SubmitPendingRecord));

  if ((response.status === 201 || response.status === 200) && reply?.status === "accepted") {
    await apply((current) => marker(current, "accepted")); // credential, answers and drafts erased
    return { kind: "accepted" };
  }
  if (response.status === 409 && code === "credential_spent") {
    await apply((current) => marker(current, "spent"));
    return { kind: "spent" };
  }
  if (response.status === 410 || (response.status === 404 && code === "not_found")) {
    await apply(() => null);
    return { kind: "closed" };
  }
  if (response.status === 400 && code === "invalid_credential") {
    await apply((current) => marker(current, "credential_invalid"));
    return { kind: "invalid_credential" };
  }
  if (response.status === 422 || (response.status === 400 && code === "invalid_request")) {
    // This exact payload was refused by validation, so no attempt with it was stored.
    await apply(backToUsable);
    return { kind: "edit", field: typeof reply?.error?.field === "string" ? reply.error.field : undefined };
  }
  if (response.status === 429 || (response.status === 503 && code === "capacity_unavailable")) {
    // Before any uncertainty this proves nothing was stored; afterwards it proves nothing.
    await apply((current) => (current.uncertain ? current : backToUsable(current)));
    return { kind: "retry_later" };
  }
  return markUncertain(pollId);
}

async function markUncertain(pollId: string): Promise<SubmitOutcome> {
  await transition(pollId, ["submit_pending"], (current) => ({ ...(current as SubmitPendingRecord), uncertain: true }));
  return { kind: "uncertain" };
}
