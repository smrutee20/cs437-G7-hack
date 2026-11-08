import type { CSSProperties, ReactNode } from "react";
import { DotDisplay } from "./DotDisplay";
import styles from "./Plates.module.css";

export function InfoIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><g fill="none" stroke="#d4d4d4" strokeWidth="1.2" strokeLinecap="round">
    <circle cx="8" cy="8" r="6" /><line x1="8" y1="7.2" x2="8" y2="11" /><line x1="8" y1="5" x2="8" y2="5.1" /></g></svg>;
}
export function WarnIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><g fill="none" stroke="#f0b14a" strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round">
    <path d="M8 2 14.5 13.5h-13z" /><line x1="8" y1="6.5" x2="8" y2="9.5" /><line x1="8" y1="11.5" x2="8" y2="11.6" /></g></svg>;
}

/** Engraved panel for mandatory wording, shown verbatim at full contrast. */
export function NoticePlate({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return <section className={`${styles.notice} ${className ?? ""}`} aria-label={title}>
    {["tl", "tr", "bl", "br"].map((corner) => <span key={corner} className={`${styles.screw} ${styles[corner]}`} aria-hidden="true" />)}
    <div className={styles.noticeTitle}><InfoIcon />{title}</div>
    <div className={styles.noticeBody}>{children}</div>
  </section>;
}

/** Amber disclosure plate: credential-loss and identification warnings only. */
export function WarningPlate({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`${styles.warning} ${className ?? ""}`}><WarnIcon /><span>{children}</span></div>;
}

/** Dim WITHHELD display. Never contains a number. */
export function WithheldPlate({ children, size = 3 }: { children: ReactNode; size?: number }) {
  return <div className={styles.withheld}>
    <DotDisplay text="WITHHELD" label="Withheld" tone="dim" dot={size} dotGap={size > 3 ? 2 : 1} glyphGap={size + 1} windowed off="face" />
    <p className={styles.withheldText}>{children}</p>
  </div>;
}

/** LED chase that replaces every spinner; runs only while waiting. */
export function MarqueeLights({ active, count = 15 }: { active: boolean; count?: number }) {
  return <svg className={`${styles.leds} ${active ? styles.ledsRun : ""}`} width={count * 18} height="16" viewBox={`0 0 ${count * 18} 16`} aria-hidden="true">
    {Array.from({ length: count }, (_, i) => <circle key={i} className={styles.led} cx={8 + i * 18} cy="8" r="3"
      style={{ "--d": `${i * 0.07}s` } as CSSProperties} />)}
  </svg>;
}
