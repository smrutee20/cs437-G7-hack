// Public-side admission (SPEC.md §14). Buckets are keyed only by route class or
// public poll ID — never IP, user agent, cookie, device, credential or nullifier.
// In memory only; idle per-poll entries are forgotten; decisions are not logged.
export type Admission = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** Integer token arithmetic: one token = 1000 units; refill adds `rate` units per millisecond. */
type State = { units: number; last: number };
function takeFrom(state: State, rate: number, burst: number, now: number): Admission {
  const capacity = burst * 1000;
  state.units = Math.min(capacity, state.units + Math.max(0, now - state.last) * rate);
  state.last = now;
  if (state.units >= 1000) {
    state.units -= 1000;
    return { allowed: true };
  }
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((1000 - state.units) / rate / 1000)) };
}

export function createTokenBucket(options: { ratePerSecond: number; burst: number; now?: () => number }) {
  const now = options.now ?? Date.now;
  const state: State = { units: options.burst * 1000, last: now() };
  return { take: (): Admission => takeFrom(state, options.ratePerSecond, options.burst, now()) };
}

export function createKeyedBuckets(options: { ratePerSecond: number; burst: number; idleMs: number; now?: () => number }) {
  const now = options.now ?? Date.now;
  const buckets = new Map<string, State>();
  let lastSweep = now();
  return {
    take(key: string): Admission {
      const instant = now();
      if (instant - lastSweep >= Math.min(options.idleMs, 60_000)) {
        lastSweep = instant;
        for (const [name, state] of buckets) if (instant - state.last >= options.idleMs) buckets.delete(name);
      }
      let state = buckets.get(key);
      if (!state) buckets.set(key, state = { units: options.burst * 1000, last: instant });
      return takeFrom(state, options.ratePerSecond, options.burst, instant);
    },
    size: () => buckets.size,
  };
}

export class Overloaded extends Error {
  constructor() { super("overloaded"); }
}

/** Bounded concurrency with a bounded, time-limited queue; a slot is always released. */
export function createSemaphore(options: { concurrent: number; queue: number; waitMs: number }) {
  let active = 0;
  const waiting: Array<() => void> = [];
  const acquire = async () => {
    if (active < options.concurrent && waiting.length === 0) { active++; return; }
    if (waiting.length >= options.queue) throw new Overloaded();
    await new Promise<void>((resolve, reject) => {
      const grant = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        const index = waiting.indexOf(grant);
        if (index >= 0) waiting.splice(index, 1);
        reject(new Overloaded());
      }, options.waitMs);
      waiting.push(grant);
    });
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next(); else active--;
  };
  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      await acquire();
      try { return await task(); } finally { release(); }
    },
  };
}
