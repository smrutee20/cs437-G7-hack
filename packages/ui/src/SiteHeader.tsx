import type { ReactNode } from "react";
import styles from "./SiteHeader.module.css";

export function BrandMark() {
  return <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true"><g fill="none" stroke="#d4d4d4" strokeWidth="1.2" strokeLinejoin="round">
    <polygon points="14,3 25,9 14,15 3,9" /><polygon points="3,9 14,15 14,26 3,20" /><polygon points="14,15 25,9 25,20 14,26" />
    <line x1="5.5" y1="13.5" x2="11.5" y2="17" /></g></svg>;
}
export function SiteHeader({ site, children }: { site?: string; children?: ReactNode }) {
  return <header className={styles.header}><div className={styles.inner}>
    <a className={styles.brand} href="/"><BrandMark /><span className={styles.name}>IITGN Feedback</span>
      {site && <><span className={styles.rule} aria-hidden="true" /><span className={styles.site}>{site}</span></>}</a>
    {children && <div className={styles.right}>{children}</div>}
  </div></header>;
}
/** Response site: makes it explicit that this window does not know who you are. */
export function NoSignInChip() {
  return <span className={styles.chip}><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <g fill="none" stroke="#a3a3a3" strokeWidth="1.2" strokeLinecap="round"><circle cx="8" cy="5.5" r="2.5" />
      <path d="M3 13.5c.8-2.4 2.7-3.5 5-3.5s4.2 1.1 5 3.5" /><line x1="2.5" y1="2.5" x2="13.5" y2="13.5" /></g></svg>No sign-in on this site</span>;
}
export function BadgeIcon({ size = 22 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 30 30" aria-hidden="true"><g fill="none" stroke="#d4d4d4" strokeWidth="1.4" strokeLinejoin="round">
    <rect x="3" y="6" width="24" height="18" rx="3" /><circle cx="10.5" cy="13.5" r="3" /><path d="M6.5 20.5c.7-1.8 2.1-2.7 4-2.7s3.3.9 4 2.7" />
    <line x1="17.5" y1="12" x2="23.5" y2="12" /><line x1="17.5" y1="16" x2="22" y2="16" /></g></svg>;
}
/** Portal: the ID badge with the signed-in institutional address. */
export function IdentityChip({ email }: { email: string }) {
  return <span className={`${styles.chip} ${styles.badge}`}><BadgeIcon /><span className={styles.badgeText}>{email}</span></span>;
}
