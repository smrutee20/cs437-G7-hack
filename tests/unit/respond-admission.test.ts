// SPEC.md §14 public-side admission: token buckets keyed only by route class or
// public poll ID, and a bounded queue for signature verification.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createKeyedBuckets, createSemaphore, createTokenBucket, Overloaded } from "../../services/respond-api/src/admission";

test("a token bucket admits its burst, then refills at its rate with an integer Retry-After", () => {
  let clock = 0;
  const bucket = createTokenBucket({ ratePerSecond: 20, burst: 40, now: () => clock });
  for (let i = 0; i < 40; i++) expect(bucket.take()).toEqual({ allowed: true });
  expect(bucket.take()).toEqual({ allowed: false, retryAfterSeconds: 1 });
  clock += 49; // 0.98 tokens
  expect(bucket.take().allowed).toBe(false);
  clock += 1; // one token after 50 ms at 20/s
  expect(bucket.take()).toEqual({ allowed: true });
  expect(bucket.take().allowed).toBe(false);
  clock += 10_000; // refill caps at the burst
  for (let i = 0; i < 40; i++) expect(bucket.take().allowed).toBe(true);
  expect(bucket.take().allowed).toBe(false);
});

test("per-poll buckets are independent, and idle ones are forgotten within ten minutes", () => {
  let clock = 0;
  const polls = createKeyedBuckets({ ratePerSecond: 5, burst: 10, idleMs: 600_000, now: () => clock });
  for (let i = 0; i < 10; i++) expect(polls.take("poll-a").allowed).toBe(true);
  expect(polls.take("poll-a")).toEqual({ allowed: false, retryAfterSeconds: 1 });
  expect(polls.take("poll-b").allowed).toBe(true);
  expect(polls.size()).toBe(2);
  clock += 600_000;
  polls.take("poll-c");
  expect(polls.size()).toBe(1);
});

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });
const track = (promise: Promise<unknown>) => {
  const state = { value: "pending" };
  promise.then(() => { state.value = "done"; }, (error) => { state.value = error instanceof Overloaded ? "overloaded" : "error"; });
  return state;
};

test("four verifications run at once, twenty wait at most two seconds, and the rest are refused immediately", async () => {
  const gate = createSemaphore({ concurrent: 4, queue: 20, waitMs: 2000 });
  const releases: (() => void)[] = [];
  const blocker = () => new Promise<void>((resolve) => { releases.push(resolve); });
  const running = Array.from({ length: 4 }, () => track(gate.run(blocker)));
  const waiting = Array.from({ length: 20 }, () => track(gate.run(blocker))); // each holds its slot once granted
  const refused = track(gate.run(async () => undefined));
  await vi.advanceTimersByTimeAsync(0);
  expect(releases).toHaveLength(4);
  expect(refused.value).toBe("overloaded");
  releases[0]();
  await vi.advanceTimersByTimeAsync(0);
  expect(running[0].value).toBe("done");
  expect(releases).toHaveLength(5); // waiting[0] took the freed slot and started
  await vi.advanceTimersByTimeAsync(2000);
  expect(waiting.slice(1).every((entry) => entry.value === "overloaded")).toBe(true);
  // A task that throws still releases its slot.
  releases.slice(1).forEach((release) => release());
  await vi.advanceTimersByTimeAsync(0);
  expect(waiting[0].value).toBe("done");
  const failing = track(gate.run(async () => { throw new Error("verify failed"); }));
  await vi.advanceTimersByTimeAsync(0);
  expect(failing.value).toBe("error");
  const after = Array.from({ length: 4 }, () => track(gate.run(async () => undefined)));
  await vi.advanceTimersByTimeAsync(0);
  expect(after.every((entry) => entry.value === "done")).toBe(true);
});
