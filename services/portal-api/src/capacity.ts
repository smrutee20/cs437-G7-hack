// Bounded native-signing admission (SPEC.md §14). A slot is reserved, and the
// signer's health checked, before any entitlement is consumed (§9 step 1).
import { ClaimError } from "./claim.js";

export type SigningCapacity = { reserve: () => Promise<() => void> };

export function createSigningCapacity(options: {
  concurrent: number; queue: number; waitMs: number; healthy: () => Promise<boolean>;
}): SigningCapacity {
  let active = 0;
  const waiting: Array<() => void> = [];
  const refuse = () => new ClaimError("capacity_unavailable");

  const acquire = async (): Promise<void> => {
    if (active < options.concurrent && waiting.length === 0) {
      active++;
      return;
    }
    if (waiting.length >= options.queue) throw refuse();
    await new Promise<void>((resolve, reject) => {
      const grant = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        const index = waiting.indexOf(grant);
        if (index >= 0) waiting.splice(index, 1);
        reject(refuse());
      }, options.waitMs);
      waiting.push(grant);
    });
    // The releasing holder handed its slot over; `active` is unchanged.
  };

  return {
    async reserve() {
      await acquire();
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        const next = waiting.shift();
        if (next) next();
        else active--;
      };
      let healthy = false;
      try { healthy = await options.healthy(); } catch { healthy = false; }
      if (!healthy) {
        release();
        throw refuse();
      }
      return release;
    },
  };
}
