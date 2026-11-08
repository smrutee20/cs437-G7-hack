// Response-origin participant state (SPEC.md §8 "Origin ownership and persistence").
// IndexedDB only — never URLs, window.name, cookies or server storage. Every
// transition runs under a per-poll Web Lock, writes in one transaction, and is
// read back before the caller may act on it. Other tabs get a non-secret
// notification and re-read.

export type PreparedRecord = {
  pollId: string; state: "prepared"; keyId: string; keyVersion: 1; closesAt: string;
  prepared: Uint8Array; blinded: Uint8Array; inverse: Uint8Array;
};
export type ClaimSentRecord = Omit<PreparedRecord, "state"> & { state: "claim_sent"; sentAt: number };
export type UsableRecord = {
  pollId: string; state: "usable"; keyId: string; keyVersion: 1; closesAt: string;
  prepared: Uint8Array; signature: Uint8Array;
};
/** Non-secret terminal marker. No response or claim identifier. */
export type MarkerRecord = { pollId: string; state: "claim_consumed" | "claim_uncertain"; closesAt: string };
export type CredentialRecord = PreparedRecord | ClaimSentRecord | UsableRecord | MarkerRecord;
export type CredentialState = CredentialRecord["state"];

/** The bridge may resend its one result for two minutes; after that the attempt is stranded. */
export const CLAIM_RESULT_WINDOW_MS = 2 * 60 * 1000;
const MARKER_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const DB_NAME = "iitgn-feedback";
const STORE = "credentials";

export class StorageFailure extends Error {
  constructor() { super("credential storage failed"); }
}
/** The stored state was not one the caller may transition from. */
export class StateConflict extends Error {
  constructor(readonly current: CredentialRecord | null) { super("credential state changed"); }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "pollId" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("blocked"));
  });
}

async function run<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest | void): Promise<T | undefined> {
  const db = await openDb();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      let request: IDBRequest | void;
      const tx = db.transaction(STORE, mode, { durability: "strict" });
      tx.oncomplete = () => resolve(request ? request.result as T : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("aborted"));
      try {
        request = op(tx.objectStore(STORE));
      } catch (error) {
        tx.abort();
        reject(error);
      }
    });
  } finally {
    db.close();
  }
}

export async function readRecord(pollId: string): Promise<CredentialRecord | null> {
  return (await run<CredentialRecord>("readonly", (store) => store.get(pollId))) ?? null;
}

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    return a.length === b.length && a.every((byte, index) => byte === b[index]);
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length &&
      keys.every((key) => same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
  }
  return a === b;
}

/** Writes (or deletes, for null) and confirms the result by reading it back in a new transaction. */
async function writeVerified(pollId: string, next: CredentialRecord | null): Promise<void> {
  try {
    await run("readwrite", (store) => (next ? store.put(next) : store.delete(pollId)));
    if (!same(await readRecord(pollId), next)) throw new StorageFailure();
  } catch {
    throw new StorageFailure();
  }
  notify(pollId);
}

const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(DB_NAME) : null;
function notify(pollId: string) {
  channel?.postMessage({ pollId }); // non-secret: other tabs re-read IndexedDB
}
export function onRecordChange(pollId: string, listener: () => void): () => void {
  if (!channel) return () => {};
  const handler = (event: MessageEvent) => {
    if (event.data && typeof event.data === "object" && event.data.pollId === pollId) listener();
  };
  channel.addEventListener("message", handler);
  return () => channel.removeEventListener("message", handler);
}

export function withPollLock<T>(pollId: string, action: () => Promise<T>): Promise<T> {
  // The lock is held until `action` settles; request() resolves with its result.
  return navigator.locks.request(`iitgn-feedback-claim:${pollId}`, action) as unknown as Promise<T>;
}

/** Creates a prepared record unless one already exists; never overwrites another tab's state. */
export function prepareIfAbsent(pollId: string, create: () => Promise<PreparedRecord>): Promise<CredentialRecord> {
  return withPollLock(pollId, async () => {
    const current = await readRecord(pollId);
    if (current) return current;
    const record = await create();
    await writeVerified(pollId, record);
    return record;
  });
}

/** Compare-and-set: applies `next` only if the stored state is one of `from`. */
export function transition<T extends CredentialRecord | null>(pollId: string, from: readonly CredentialState[],
  next: (current: CredentialRecord) => Promise<T> | T): Promise<T> {
  return withPollLock(pollId, async () => {
    const current = await readRecord(pollId);
    if (!current || !from.includes(current.state)) throw new StateConflict(current);
    const result = await next(current);
    await writeVerified(pollId, result);
    return result;
  });
}

export const marker = (record: CredentialRecord, state: MarkerRecord["state"]): MarkerRecord =>
  ({ pollId: record.pollId, state, closesAt: record.closesAt });

/**
 * Erases what must not outlive its purpose: unused credentials once the poll is
 * observed closed or withdrawn, a stranded claim after the result window, and
 * non-secret markers seven days after closure. Run on start, load and while open.
 */
export function sweep(pollId: string, observed: { open: boolean } | null, now = Date.now()): Promise<CredentialRecord | null> {
  return withPollLock(pollId, async () => {
    const current = await readRecord(pollId);
    if (!current) return null;
    let next: CredentialRecord | null = current;
    if (current.state === "claim_consumed" || current.state === "claim_uncertain") {
      if (now >= Date.parse(current.closesAt) + MARKER_LIFETIME_MS) next = null;
    } else if (observed && !observed.open) {
      next = null;
    } else if (current.state === "claim_sent" && now - current.sentAt >= CLAIM_RESULT_WINDOW_MS) {
      next = marker(current, "claim_uncertain");
    }
    if (next !== current) await writeVerified(pollId, next);
    return next;
  });
}
