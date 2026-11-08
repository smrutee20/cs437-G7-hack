import type { CSSProperties } from "react";
import { glyph, SCRAMBLE_POOL } from "./glyphs";
import { useScramble } from "./motion";
import styles from "./DotDisplay.module.css";

export type DotTone = "dim" | "lit";
export type DotDisplayProps = {
  /** System text only (states, numbers). Never user-written content. */
  text: string;
  /** Accessible name carrying the real text. */
  label: string;
  tone?: DotTone;
  dot?: number;
  dotGap?: number;
  glyphGap?: number;
  windowed?: boolean;
  off?: "default" | "transparent" | "face";
  /** Scramble-then-settle when the text changes; lit only once settled. */
  scramble?: boolean;
  scramblePool?: string;
  className?: string;
};

export function DotDisplay({ text, label, tone = "dim", dot = 3, dotGap = 1, glyphGap = 4, windowed = false, off = "default",
  scramble = false, scramblePool = SCRAMBLE_POOL, className }: DotDisplayProps) {
  const upper = text.toUpperCase();
  const { shown, settled } = useScramble(upper, scramble, scramblePool);
  const variables = { "--dot": `${dot}px`, "--dot-gap": `${dotGap}px`, "--glyph-gap": `${glyphGap}px` } as CSSProperties;
  const classes = [styles.display, settled && tone === "lit" ? styles.lit : styles.dim, windowed ? styles.window : "",
    off === "transparent" ? styles.transparentOff : off === "face" ? styles.faceOff : "", className ?? ""].join(" ");
  return (
    <span className={classes} style={variables} {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}>
      {[...shown].map((character, index) => (
        <span className={styles.glyph} key={index} aria-hidden="true">
          {glyph(character).map((on, dotIndex) => (
            <span key={dotIndex} className={`${styles.dot} ${on ? styles.on : ""}`}
              style={{ "--d": `${index * 45 + (dotIndex % 5) * 14}ms` } as CSSProperties} />
          ))}
        </span>
      ))}
    </span>
  );
}

const STATUS_TEXT = { draft: "DRAFT", open: "OPEN", closed: "CLOSED", withdrawn: "WITHDRAWN" } as const;
/** DRAFT / OPEN / CLOSED / WITHDRAWN. Only OPEN is lit. */
export function StatusPlate({ status }: { status: keyof typeof STATUS_TEXT }) {
  return <DotDisplay text={STATUS_TEXT[status]} label={`Status: ${status}`} tone={status === "open" ? "lit" : "dim"}
    dot={2} dotGap={1} glyphGap={3} windowed />;
}
