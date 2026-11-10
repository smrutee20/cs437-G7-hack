// Policy v1 is frozen for existing polls; new polls use v2. The database
// constrains both versions and the API reports the policy of each poll.
export function pollPolicy(version: number) {
  if (version === 1) return { version: 1, minEligible: 10, minResponses: 5, minAnswersPerQuestion: 5 };
  if (version === 2) return { version: 2, minEligible: 1, minResponses: 1, minAnswersPerQuestion: 1 };
  throw new Error("unsupported poll policy");
}
