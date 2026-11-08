import { DotDisplay } from "./DotDisplay";
import styles from "./Inputs.module.css";

/** Five dot-matrix numeral keys with native radio semantics (keyboard operable); the chosen key lights. */
export function RatingKeys({ name, value, disabled, onChange }: {
  name: string; value: string | undefined; disabled?: boolean; onChange: (value: string) => void;
}) {
  return <>
    <div className={styles.keys}>
      {["1", "2", "3", "4", "5"].map((n) => (
        <label key={n} className={styles.key}>
          <input className={styles.radio} type="radio" name={name} value={n} checked={value === n} disabled={disabled}
            onChange={() => onChange(n)} />
          <span className="sr-only">{n}</span>
          <DotDisplay text={n} label="" tone={value === n ? "lit" : "dim"} dot={4} dotGap={2} off="transparent" />
        </label>
      ))}
    </div>
    <div className={styles.scale} aria-hidden="true"><span>1 · Poor</span><span>5 · Excellent</span></div>
  </>;
}

/** Option cards with a lit radio dot. Labels are organiser text, rendered as escaped plain text. */
export function ChoiceList({ name, options, value, disabled, onChange }: {
  name: string; options: { id: string; label: string }[]; value: string | undefined; disabled?: boolean; onChange: (value: string) => void;
}) {
  return <div className={styles.options}>
    {options.map((option) => (
      <label key={option.id} className={styles.option}>
        <input className={styles.radio} type="radio" name={name} value={option.id} checked={value === option.id} disabled={disabled}
          onChange={() => onChange(option.id)} />
        <span className={styles.ring} aria-hidden="true" />
        <span className={`${styles.optionLabel} user-text`}>{option.label}</span>
      </label>
    ))}
  </div>;
}

export type StepState = "done" | "current" | "todo";
export function StepList({ steps }: { steps: { label: string; state: StepState }[] }) {
  return <ol className={styles.steps}>
    {steps.map((step) => <li key={step.label} className={`${styles.step} ${step.state === "done" ? styles.done : step.state === "current" ? styles.current : ""}`}>
      <span className={styles.stepDot} aria-hidden="true" />{step.label}
      <span className="sr-only">{step.state === "done" ? " (done)" : step.state === "current" ? " (current step)" : ""}</span>
    </li>)}
  </ol>;
}
