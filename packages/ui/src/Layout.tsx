import type { ReactNode } from "react";
import { Press } from "./Machines";
import styles from "./Layout.module.css";

/** 404: the press stamps "404" onto a blank card. */
export function NotFound({ title = "Page not found", children }: { title?: string; children?: ReactNode }) {
  return <main className={styles.notFound}>
    <div className={styles.notFoundArt}><Press mode="loop404" label="A stamp press stamps 404 onto a blank card, which slides out and lights up" /></div>
    <h1 className={styles.notFoundTitle}>{title}</h1>
    <div className={styles.notFoundText}>{children ?? <p>This address does not match a page here. Poll links look like <span className="mono">/p/…</span> and come from the organiser.</p>}</div>
  </main>;
}
export function Card({ children, className, ...rest }: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLElement>) {
  return <section className={`${styles.card} ${className ?? ""}`} {...rest}>{children}</section>;
}
export function Label({ children }: { children: ReactNode }) { return <span className={styles.label}>{children}</span>; }
export const layoutStyles = styles;
