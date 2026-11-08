// In-memory per-account attempt limit for the authenticated portal only
// (SPEC.md §14). Keyed by application user ID; never by IP, device or cookie.
// Admission decisions are not logged.
export type AttemptDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export function createAccountLimiter(options: { limit: number; windowMs: number; now?: () => number }) {
  const now = options.now ?? Date.now;
  const attempts = new Map<string, number[]>();
  let lastSweep = now();

  const sweep = (instant: number) => {
    if (instant - lastSweep < options.windowMs) return;
    lastSweep = instant;
    for (const [account, times] of attempts) {
      if (times[times.length - 1] <= instant - options.windowMs) attempts.delete(account);
    }
  };

  return {
    attempt(account: string): AttemptDecision {
      const instant = now();
      sweep(instant);
      const recent = (attempts.get(account) ?? []).filter((time) => time > instant - options.windowMs);
      if (recent.length >= options.limit) {
        attempts.set(account, recent);
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((recent[0] + options.windowMs - instant) / 1000)) };
      }
      recent.push(instant);
      attempts.set(account, recent);
      return { allowed: true };
    },
    trackedAccounts: () => attempts.size,
  };
}
