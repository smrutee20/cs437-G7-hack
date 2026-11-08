import { useEffect, useState } from "react";

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Scramble-then-settle (≈8 frames at 55 ms, settling left to right). Returns the
 * text to draw and whether it has settled; reduced motion jumps to the end.
 */
export function useScramble(text: string, enabled: boolean, pool: string): { shown: string; settled: boolean } {
  const [frame, setFrame] = useState<{ shown: string; settled: boolean }>({ shown: text, settled: true });
  useEffect(() => {
    if (!enabled || prefersReducedMotion()) { setFrame({ shown: text, settled: true }); return; }
    let n = 0;
    const timer = window.setInterval(() => {
      n++;
      if (n > 8) { window.clearInterval(timer); setFrame({ shown: text, settled: true }); return; }
      let out = "";
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        out += ch === " " || ch === "." || i < n - 3 ? ch : pool[Math.floor(Math.random() * pool.length)];
      }
      setFrame({ shown: out, settled: false });
    }, 55);
    return () => window.clearInterval(timer);
  }, [text, enabled, pool]);
  return frame;
}
