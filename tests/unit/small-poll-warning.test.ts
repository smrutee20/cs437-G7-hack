import { expect, test } from "vitest";
import { SMALL_POLL_THRESHOLD, smallPollWarning } from "../../apps/respond/src/small-poll";

const poll = (eligibleCount: unknown, minResponses: number) => ({ eligibleCount, policy: { minResponses } });

test("the threshold is five", () => {
  expect(SMALL_POLL_THRESHOLD).toBe(5);
});

test("few eligible people and a low response minimum are both named with their numbers", () => {
  const text = smallPollWarning(poll(3, 1))!;
  expect(text).toContain("Only 3 people can respond to this poll.");
  expect(text).toContain("as few as 1 response.");
  expect(text).toMatch(/work out which answers are yours/);
  expect(smallPollWarning(poll(1, 1))).toContain("Only 1 person can respond to this poll.");
});

test("each condition warns on its own", () => {
  const lowMinimum = smallPollWarning(poll(12, 1))!;
  expect(lowMinimum).toContain("as few as 1 response.");
  expect(lowMinimum).not.toContain("can respond to this poll");
  const fewEligible = smallPollWarning(poll(4, 5))!;
  expect(fewEligible).toContain("Only 4 people can respond to this poll.");
  expect(fewEligible).not.toContain("as few as");
  expect(smallPollWarning(poll(20, 2))).toContain("as few as 2 responses.");
});

test("no warning at or above the threshold", () => {
  expect(smallPollWarning(poll(5, 5))).toBeNull();
  expect(smallPollWarning(poll(10, 5))).toBeNull();
});

test("a missing or malformed eligible count is treated as below the threshold", () => {
  for (const count of [undefined, null, "12", -1, 2.5, Number.NaN]) {
    expect(smallPollWarning(poll(count, 5))).toContain("did not say how many people can respond");
  }
});
