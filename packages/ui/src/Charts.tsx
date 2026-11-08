import type { CSSProperties } from "react";
import styles from "./Charts.module.css";

/** Horizontal bar of dots lit in proportion to `fraction`. Decorative: exact numbers are always shown as text. */
export function DotBar({ fraction, lit, cells = 40, delayBase = 0 }: { fraction: number; lit: boolean; cells?: number; delayBase?: number }) {
  const on = Math.round(Math.max(0, Math.min(1, fraction)) * cells);
  return <div className={styles.bar} style={{ "--cells": cells } as CSSProperties} aria-hidden="true">
    {Array.from({ length: cells }, (_, i) => <span key={i} className={`${styles.cell} ${lit && i < on ? styles.on : ""}`}
      style={{ "--d": `${delayBase + i * 22}ms` } as CSSProperties} />)}
  </div>;
}

/** Vertical two-dot-wide column, `rows` tall. Decorative. */
export function DotColumn({ fraction, lit, rows = 12, delayBase = 0 }: { fraction: number; lit: boolean; rows?: number; delayBase?: number }) {
  const height = Math.round(Math.max(0, Math.min(1, fraction)) * rows);
  return <div className={styles.column} aria-hidden="true">
    {Array.from({ length: rows * 2 }, (_, i) => {
      const fromBottom = rows - 1 - Math.floor(i / 2);
      return <span key={i} className={`${styles.cell} ${lit && fromBottom < height ? styles.on : ""}`}
        style={{ "--d": `${delayBase + fromBottom * 35}ms` } as CSSProperties} />;
    })}
  </div>;
}
