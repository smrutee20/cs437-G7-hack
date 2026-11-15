// Warning shown before a claim when a poll is small enough that answers may be
// traced back to the person who gave them (issue #4). Anonymous credentials hide
// who submitted; they cannot hide much when only a handful of people respond.
export const SMALL_POLL_THRESHOLD = 5;

type SmallPollInput = { eligibleCount?: unknown; policy: { minResponses: number } };

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** Specific warning text, or null when both the eligible count and the response minimum are at least the threshold. */
export function smallPollWarning(poll: SmallPollInput): string | null {
  const count = poll.eligibleCount;
  const known = typeof count === "number" && Number.isSafeInteger(count) && count >= 0;
  const parts: string[] = [];
  if (!known) parts.push("This poll did not say how many people can respond.");
  else if (count < SMALL_POLL_THRESHOLD) parts.push(`Only ${plural(count, "person", "people")} can respond to this poll.`);
  const minimum = poll.policy.minResponses;
  if (minimum < SMALL_POLL_THRESHOLD) {
    parts.push(`The organiser will see results after as few as ${plural(minimum, "response", "responses")}.`);
  }
  if (parts.length === 0) return null;
  parts.push("With so few responses, the organiser or others who know the group may be able to work out which answers are yours, " +
    "even though your credential does not carry your name. Decide whether to take part before you prepare a credential.");
  return parts.join(" ");
}
