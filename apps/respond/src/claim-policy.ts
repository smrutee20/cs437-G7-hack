// Response-side effect of a bridge claim error (SPEC.md §8). Only a definitive
// pre-insert rejection may return to `prepared`; anything that might have
// consumed the entitlement never permits an automatic or silent new claim.
import type { ClaimResultError } from "@iitgn-feedback/protocol";

export type ClaimErrorEffect = "retry" | "consumed" | "closed" | "uncertain";

const EFFECT: Record<ClaimResultError, ClaimErrorEffect> = {
  not_attempted: "retry", login_required: "retry", csrf_failed: "retry", forbidden: "retry",
  invalid_request: "retry", not_eligible: "retry", rate_limited: "retry", capacity_unavailable: "retry",
  claim_consumed: "consumed", claim_consumed_no_credential: "consumed",
  poll_closed: "closed", poll_withdrawn: "closed", not_found: "closed",
  temporarily_unavailable: "uncertain",
};

export function claimErrorEffect(code: ClaimResultError): ClaimErrorEffect {
  return EFFECT[code] ?? "uncertain";
}
