// SPEC.md §14 claim admission: two concurrent native sign operations, at most ten
// waiting for two seconds, and five attempts per minute per authenticated account.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createSigningCapacity } from "../../services/portal-api/src/capacity";
import { createAccountLimiter } from "../../services/portal-api/src/rate-limit";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const outcome = (promise: Promise<unknown>) => {
  const state = { value: "pending" as string };
  promise.then(() => { state.value = "granted"; }, (error) => { state.value = (error as { code?: string }).code ?? "error"; });
  return state;
};
const settle = () => vi.advanceTimersByTimeAsync(0);

test("two signing slots are granted at once; a waiter gets a slot only when one is released", async () => {
  const capacity = createSigningCapacity({ concurrent: 2, queue: 10, waitMs: 2000, healthy: async () => true });
  const releaseA = await capacity.reserve();
  await capacity.reserve();
  const third = capacity.reserve(), state = outcome(third);
  await vi.advanceTimersByTimeAsync(1999);
  expect(state.value).toBe("pending");
  releaseA();
  releaseA(); // releasing twice must not free a second slot
  await settle();
  expect(state.value).toBe("granted");
  const fourth = outcome(capacity.reserve());
  await vi.advanceTimersByTimeAsync(1000);
  expect(fourth.value).toBe("pending");
});

test("a waiter gives up after two seconds and the eleventh waiter is refused immediately", async () => {
  const capacity = createSigningCapacity({ concurrent: 2, queue: 10, waitMs: 2000, healthy: async () => true });
  await capacity.reserve(); await capacity.reserve();
  const waiters = Array.from({ length: 10 }, () => outcome(capacity.reserve()));
  const overflow = outcome(capacity.reserve());
  await settle();
  expect(overflow.value).toBe("capacity_unavailable");
  expect(waiters.every((waiter) => waiter.value === "pending")).toBe(true);
  await vi.advanceTimersByTimeAsync(2000);
  expect(waiters.every((waiter) => waiter.value === "capacity_unavailable")).toBe(true);
  // Timed-out waiters left the queue: a new waiter can queue again.
  const again = outcome(capacity.reserve());
  await settle();
  expect(again.value).toBe("pending");
});

test("an unhealthy signer refuses before any claim and returns its slot", async () => {
  let healthy = false;
  const capacity = createSigningCapacity({ concurrent: 1, queue: 10, waitMs: 2000, healthy: async () => healthy });
  const refused = outcome(capacity.reserve());
  await settle();
  expect(refused.value).toBe("capacity_unavailable");
  const broken = createSigningCapacity({ concurrent: 1, queue: 10, waitMs: 2000,
    healthy: async () => { throw new Error("connection refused"); } });
  const thrown = outcome(broken.reserve());
  await settle();
  expect(thrown.value).toBe("capacity_unavailable");
  healthy = true;
  const granted = outcome(capacity.reserve());
  await settle();
  expect(granted.value).toBe("granted"); // the refused attempt did not keep the only slot
});

test("an account gets five claim attempts per minute; others are independent and idle entries expire", () => {
  let clock = 1_000_000;
  const limiter = createAccountLimiter({ limit: 5, windowMs: 60_000, now: () => clock });
  for (let i = 0; i < 5; i++) expect(limiter.attempt("alice")).toEqual({ allowed: true });
  expect(limiter.attempt("alice")).toEqual({ allowed: false, retryAfterSeconds: 60 });
  expect(limiter.attempt("bob")).toEqual({ allowed: true });
  clock += 59_500;
  expect(limiter.attempt("alice")).toEqual({ allowed: false, retryAfterSeconds: 1 });
  clock += 500; // the first five attempts have left the sliding 60 s window
  for (let i = 0; i < 5; i++) expect(limiter.attempt("alice")).toEqual({ allowed: true });
  expect(limiter.attempt("alice")).toEqual({ allowed: false, retryAfterSeconds: 60 });
  expect(limiter.trackedAccounts()).toBe(1); // bob's lone attempt aged out of the window and was swept
  clock += 120_000;
  limiter.attempt("carol");
  expect(limiter.trackedAccounts()).toBe(1); // only carol remains in memory
});
