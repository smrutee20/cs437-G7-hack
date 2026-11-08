// Organiser results (SPEC.md §11). Every value renders through React's text
// escaping: no HTML, Markdown or links. Dot charts are decorative; exact counts
// and percentages are always present as text.
import { useEffect, useState } from "react";
import { DotBar, DotColumn, DotDisplay, StatusPlate, WithheldPlate } from "@iitgn-feedback/ui";
import styles from "./Portal.module.css";

export type Option = { id: string; label: string };
export type Question = { id: string; type: "single_choice" | "rating" | "free_text"; prompt: string; required: boolean; options?: Option[] };
type PublishedQuestion = { questionId: string; state: "published"; answeredCount: number; skippedCount: number } & (
  { type: "single_choice"; options: { optionId: string; count: number; percentage: number }[] } |
  { type: "rating"; mean: number; distribution: { value: number; count: number; percentage: number }[] } |
  { type: "free_text"; texts: string[] });
type ResultItem = PublishedQuestion | { questionId: string; state: "withheld"; reason: "insufficient_answers" };
export type Results = { state: "withheld"; reason: "insufficient_responses" } | { state: "ready"; totalResponses: number; questions: ResultItem[] };
export type ResultsView = { title: string; questions: Question[]; closedAt: string | null } &
  ({ kind: "loaded"; results: Results } | { kind: "message"; text: string; withdrawn?: boolean });

const TYPE = { single_choice: "Single choice", rating: "Rating", free_text: "Free text" } as const;
const pct = (value: number) => `${value.toFixed(1)}%`;
export const RESULT_GUIDANCE = "Results appear only after closure and at least five responses, and each question needs five answers. " +
  "This is a publication threshold, not anonymity: small counts, unanimous answers, free text, repeated polls and outside knowledge " +
  "can still point to individuals. Share with care. Free-text answers are shown exactly as written, in an independent random order.";

function useReveal(): boolean {
  const [lit, setLit] = useState(false);
  useEffect(() => { const timer = window.setTimeout(() => setLit(true), 450); return () => window.clearTimeout(timer); }, []);
  return lit;
}

export function ResultsPanel({ view, onBack }: { view: ResultsView; onBack: () => void }) {
  const lit = useReveal();
  const question = (id: string) => view.questions.find((candidate) => candidate.id === id);
  const closed = view.closedAt ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(view.closedAt)) : "";
  return <section aria-label="Results" className={styles.results}>
    <div><button type="button" className={styles.back} onClick={onBack}>← All polls</button></div>
    <div className={styles.resultsHead}>
      <div className={styles.statusRow}>
        <StatusPlate status={view.kind === "message" && view.withdrawn ? "withdrawn" : "closed"} />
        {closed && <span className={styles.meta}>Closed {closed}</span>}
        {view.closedAt && <span className={`mono ${styles.utc}`}>{view.closedAt}</span>}
      </div>
      <h2 className={`${styles.resultsTitle} user-text`}>Results: {view.title}</h2>
    </div>
    {view.kind === "message" ? <div className={styles.heldBig}>
      <DotDisplay text={view.withdrawn ? "WITHDRAWN" : "--"} label={view.withdrawn ? "Withdrawn" : "Unavailable"} dot={5} dotGap={2} glyphGap={6} windowed off="face" />
      <p className={styles.heldText}>{view.text}</p>
    </div> : view.results.state === "withheld" ? <div className={styles.heldBig}>
      <DotDisplay text="WITHHELD" label="Withheld" dot={5} dotGap={2} glyphGap={6} windowed off="face" />
      <h3 className={styles.heldTitle}>Results permanently withheld</h3>
      <p className={styles.heldText}>Results are permanently withheld: fewer than five responses were received.</p>
      <p className={styles.heldSub}>There is no override, and the exact number of responses isn’t shown either.</p>
    </div> : <>
      <div className={styles.summary}>
        <div className={styles.totalBox}>
          <DotDisplay text={String(view.results.totalResponses)} label={`${view.results.totalResponses} responses`} tone={lit ? "lit" : "dim"}
            dot={6} dotGap={2} glyphGap={8} scramble scramblePool="0123456789" off="face" />
          <span className={styles.totalLabel} aria-hidden="true">RESPONSES</span>
          <span className="sr-only">{view.results.totalResponses} responses</span>
        </div>
        <div className={styles.summaryText}>
          <p>Results were sealed when the poll closed. A question is shown only if at least five people answered it.</p>
          <p className={styles.guidance}>{RESULT_GUIDANCE}</p>
        </div>
      </div>
      {view.results.questions.map((item, index) => {
        const q = question(item.questionId);
        const head = <div className={styles.qHead}>
          <div className={styles.qMeta}><span className="mono">Q{index + 1}</span><span>{q ? TYPE[q.type] : "Question"}{q ? ` · ${q.required ? "Required" : "Optional"}` : ""}
            {item.state === "published" ? ` · ${item.answeredCount} answered · ${item.skippedCount} skipped` : ""}
            {item.state === "published" && item.type === "free_text" ? " · shown in random order" : ""}</span></div>
          <h3 className={`${styles.qPrompt} user-text`}>{q?.prompt ?? "Question"}</h3>
        </div>;
        if (item.state === "withheld") {
          return <section key={item.questionId} className={`${styles.resultCard} ${styles.withheldCard}`}>{head}
            <WithheldPlate>Withheld: fewer than five answers. No counts are shown for this question.</WithheldPlate></section>;
        }
        return <section key={item.questionId} className={styles.resultCard}>{head}
          {item.type === "single_choice" && <><ul className={styles.optionRows}>
            {item.options.map((option, optionIndex) => {
              const label = q?.options?.find((candidate) => candidate.id === option.optionId)?.label ?? "Option";
              return <li key={option.optionId} className={styles.optionRow}>
                <span className={`${styles.optionName} user-text`}>{label}</span>
                <DotBar fraction={option.percentage / 100} lit={lit} delayBase={optionIndex * 80} />
                <span className={`mono ${styles.count}`}>{option.count} · {pct(option.percentage)}</span>
                <span className="sr-only">{label}: {option.count} ({pct(option.percentage)})</span>
              </li>;
            })}
          </ul><p className={styles.note}>Percentages use the {item.answeredCount} people who answered. Totals can differ slightly from 100% because of rounding.</p></>}
          {item.type === "rating" && <div className={styles.rating}>
            <div className={styles.mean}>
              <DotDisplay text={item.mean.toFixed(2)} label={`Mean rating ${item.mean.toFixed(2)} out of 5`} tone={lit ? "lit" : "dim"}
                dot={5} dotGap={2} glyphGap={6} scramble scramblePool="0123456789" off="face" />
              <span className={styles.meta}>Mean of 5 · {item.answeredCount} answered · {item.skippedCount} skipped</span>
              <span className="sr-only">Mean {item.mean.toFixed(2)}</span>
            </div>
            <ul className={styles.columns}>
              {item.distribution.map((entry, i) => <li key={entry.value} className={styles.column}>
                <DotColumn fraction={Math.max(...item.distribution.map((d) => d.count)) ? entry.count / Math.max(...item.distribution.map((d) => d.count)) : 0}
                  lit={lit} delayBase={i * 90} />
                <span className={styles.columnValue}>{entry.value}</span>
                <span className={`mono ${styles.count}`}>{entry.count} · {pct(entry.percentage)}</span>
              </li>)}
            </ul>
          </div>}
          {item.type === "free_text" && <ul className={styles.texts}>
            {item.texts.map((text, i) => <li key={i} className={`${styles.textCard} user-text`}>{text}</li>)}
          </ul>}
        </section>;
      })}
    </>}
  </section>;
}
