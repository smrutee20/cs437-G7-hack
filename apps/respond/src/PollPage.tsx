import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { canonicalizeAnswers } from "@iitgn-feedback/protocol";
import {
  Booth, Button, ChoiceList, NoticePlate, NotFound, RatingKeys, StatusPlate, StepList, WarningPlate, type StepState,
} from "@iitgn-feedback/ui";
import { beginClaim, finishClaim, prepareCredential } from "./claim-flow";
import { missingClaimCapabilities, openClaimWindow, type ClaimWindowState } from "./claim-window";
import {
  BOOTH, countdown, LOSS_WARNING, outcomeText, PRIVACY_NOTICE, submitText, SUBMIT_WARNING, SUCCESS_BODY, TEXT_WARNING, WINDOW_TEXT,
} from "./copy";
import { onRecordChange, saveDraft, sweep, type CredentialRecord, type SubmitPendingRecord } from "./credential-store";
import { beginSubmission, sendSubmission } from "./submit-flow";
import styles from "./PollPage.module.css";

type PublicQuestion = { id: string; type: "single_choice" | "rating" | "free_text"; prompt: string; required: boolean;
  options?: { id: string; label: string }[] };
export type PublicPoll = { id: string; title: string; description: string; status: "open" | "closed"; invalidated: boolean;
  closesAt: string; closedAt: string | null; questions: PublicQuestion[]; key: { keyId: string; keyVersion: 1; publicJwk: unknown } };
type Draft = Record<string, string>;
const TYPE_LABEL = { single_choice: "Single choice", rating: "Rating", free_text: "Free text" } as const;
const WAITING: ReadonlySet<string> = new Set(["waiting_ready", "waiting_ack", "connected", "request_sent", "finishing"]);

/** Current public status, re-read before a new claim or submission (SPEC.md §8). Null if it can't be read. */
async function readStatus(pollId: string): Promise<{ open: boolean; invalidated: boolean } | null> {
  try {
    const response = await fetch(`/api/v1/polls/${pollId}/public`, { credentials: "omit", cache: "no-store" });
    if (response.status === 404) return { open: false, invalidated: false };
    if (!response.ok) return null;
    const poll = await response.json();
    return { open: poll.status === "open" && !poll.invalidated, invalidated: poll.invalidated === true };
  } catch {
    return null; // the server still decides; an unread status does not block
  }
}

function deadlineText(instant: string): string {
  return new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(instant));
}

function QuestionCard({ question, index, value, disabled, onChange }: {
  question: PublicQuestion; index: number; value: string | undefined; disabled: boolean; onChange: (value: string | undefined) => void;
}) {
  const meta = <div className={styles.qMeta}>
    <span className="mono">Q{index + 1}</span>
    <span className={question.required ? styles.pillStrong : styles.pill}>{question.required ? "Required" : "Optional"}</span>
    <span>{TYPE_LABEL[question.type]}</span>
  </div>;
  if (question.type === "free_text") {
    return <div className={styles.question}>
      <div className={styles.qHead}>{meta}<label className={`${styles.prompt} user-text`} htmlFor={`q-${question.id}`}>{question.prompt}</label></div>
      <textarea id={`q-${question.id}`} className={styles.textarea} rows={4} value={value ?? ""} disabled={disabled} maxLength={8000}
        placeholder="Optional · up to 2,000 characters" onChange={(event) => onChange(event.target.value)} />
      <WarningPlate>{TEXT_WARNING}</WarningPlate>
    </div>;
  }
  return <fieldset className={styles.question} disabled={disabled} aria-labelledby={`p-${question.id}`}>
    <div className={styles.qHead}>{meta}<span id={`p-${question.id}`} className={`${styles.prompt} user-text`}>{question.prompt}</span></div>
    {question.type === "rating"
      ? <RatingKeys name={question.id} value={value} disabled={disabled} onChange={onChange} />
      : <ChoiceList name={question.id} options={question.options ?? []} value={value} disabled={disabled} onChange={onChange} />}
    {!question.required && value !== undefined && !disabled &&
      <div><Button variant="quiet" size="small" onClick={() => onChange(undefined)}>Clear answer</Button></div>}
  </fieldset>;
}

export function PollPage({ pollId }: { pollId: string }) {
  const [poll, setPoll] = useState<PublicPoll | null>(null);
  const [load, setLoad] = useState<"loading" | "missing" | "ready">("loading");
  useEffect(() => {
    const abort = new AbortController();
    void fetch(`/api/v1/polls/${pollId}/public`, { credentials: "omit", cache: "no-store", signal: abort.signal })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("unavailable")))
      .then((body: PublicPoll) => { setPoll(body); setLoad("ready"); })
      .catch(() => { if (!abort.signal.aborted) setLoad("missing"); });
    return () => abort.abort();
  }, [pollId]);
  if (load === "loading") return <main className={styles.loading}><p>Loading public poll…</p></main>;
  if (load === "missing" || !poll) {
    return <NotFound title="This poll is not available">
      <p>It may not exist, may not be open yet, or may have been removed after its retention period. Check the link you were given.</p>
    </NotFound>;
  }
  return <PollBooth poll={poll} onClosed={(invalidated) => setPoll({ ...poll, status: "closed", invalidated: poll.invalidated || invalidated })} />;
}

function PollBooth({ poll, onClosed }: { poll: PublicPoll; onClosed: (invalidated: boolean) => void }) {
  const open = poll.status === "open" && !poll.invalidated;
  const [missing, setMissing] = useState<string[] | null>(null);
  const [record, setRecord] = useState<CredentialRecord | null | undefined>(undefined);
  const [win, setWin] = useState<{ state: ClaimWindowState | "idle"; rejected: number }>({ state: "idle", rejected: 0 });
  const [message, setMessage] = useState("");
  const [submitMessage, setSubmitMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState<Draft>({});
  const [now, setNow] = useState(() => Date.now());
  const cleanup = useRef<() => void>(() => {});
  const restored = useRef(false);
  const edited = useRef(false);

  const refresh = useCallback(async () => {
    try { setRecord(await sweep(poll.id, { open })); }
    catch { setMessage("This browser's credential storage is unavailable."); }
  }, [poll.id, open]);
  useEffect(() => {
    void missingClaimCapabilities().then(setMissing);
    const clock = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => { cleanup.current(); window.clearInterval(clock); };
  }, []);
  useEffect(() => {
    if (!missing || missing.length > 0) return;
    void refresh();
    const stop = onRecordChange(poll.id, () => void refresh());
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => { stop(); window.clearInterval(timer); };
  }, [missing, poll.id, refresh]);

  // Restore saved draft answers once; afterwards this page's edits are the source of truth.
  useEffect(() => {
    if (restored.current || record === undefined) return;
    restored.current = true;
    if (record && "draft" in record && record.draft && !edited.current) setDraft(record.draft);
  }, [record]);
  // Persist drafts with the credential state (IndexedDB only, debounced); nothing is sent anywhere.
  useEffect(() => {
    if (!edited.current) return;
    const timer = window.setTimeout(() => { void saveDraft(poll.id, draft).catch(() => {}); }, 300);
    return () => window.clearTimeout(timer);
  }, [draft, poll.id]);

  /** Re-reads public status; observed closure updates the page and erases unused state. */
  const stillOpen = async (): Promise<boolean> => {
    const status = await readStatus(poll.id);
    if (status && !status.open) {
      onClosed(status.invalidated);
      await sweep(poll.id, { open: false }).catch(() => {});
      await refresh();
      return false;
    }
    return true;
  };
  const submit = async (start: () => Promise<unknown>) => {
    setSending(true);
    setMessage(""); // the claim step is over; only submission outcomes matter now
    try {
      await start();
      setSubmitMessage(submitText(await sendSubmission(poll.id)));
    } catch {
      setSubmitMessage("Your answers could not be saved in this browser, so nothing was sent.");
    } finally {
      setSending(false);
      await refresh();
    }
  };

  const unsupported = missing !== null && missing.length > 0;
  const state = unsupported ? "unsupported" : record === undefined ? "loading" : record?.state ?? "none";
  const pending = record?.state === "submit_pending" ? record as SubmitPendingRecord : null;
  const values: Draft = pending
    ? Object.fromEntries(pending.answers.map((entry) => [entry.questionId, String(entry.value)])) : draft;
  const frozen = !open || pending !== null || sending || !["none", "prepared", "claim_sent", "usable"].includes(state);
  const windowBusy = WAITING.has(win.state);
  const finished = state === "accepted";

  const key = sending ? "sending" : state === "prepared" && windowBusy ? "waiting"
    : state === "none" && !open ? (poll.invalidated ? "withdrawn" : "closed") : state;
  const view = BOOTH[key] ?? BOOTH.none;
  const clock = countdown(poll.closesAt, now);
  const display = view.display ?? (open ? clock.display : "CLOSED");
  const stepStates = (step: number): StepState[] =>
    finished ? ["done", "done", "done"] : [1, 2, 3].map((n) => n < step ? "done" : n === step ? "current" : "todo");
  const steps = ["Seal a credential in this browser", "Get it stamped in the portal window", "Submit your answers once"];
  const stepLabel = finished ? "Done" : view.step ? `Step ${view.step} of 3` : "";

  const submitAnswers = () => {
    // The browser check only explains problems early; the server's validation is authoritative.
    const raw = poll.questions.flatMap((question) => {
      const value = draft[question.id];
      if (value === undefined || (question.type === "free_text" && value.trim() === "")) return [];
      return [{ questionId: question.id, value: question.type === "rating" ? Number(value) : value }];
    });
    const canonical = canonicalizeAnswers(poll.questions, raw);
    if (!canonical.ok) {
      setSubmitMessage(canonical.field === "answers" ? "Answer every required question before submitting."
        : "One of these answers is not valid. Check it and submit again.");
      return;
    }
    setSubmitMessage("");
    void (async () => {
      if (!(await stillOpen())) { setSubmitMessage("This poll has closed, so these answers were not sent."); return; }
      await submit(() => beginSubmission(poll.id, canonical.answers));
    })();
  };

  let primary: ReactElement | null = null;
  if (open && state === "none") {
    primary = <Button variant="primary" block disabled={busy} onClick={() => {
      setBusy(true); setMessage("");
      stillOpen().then((current) => {
        if (!current) { setMessage("This poll has closed, so no credential can be claimed."); return; }
        return prepareCredential(poll, draft).then(() => undefined);
      }).catch(() => setMessage("A credential request could not be saved in this browser. Nothing was sent."))
        .finally(() => { setBusy(false); void refresh(); });
    }}>Prepare my credential</Button>;
  } else if (open && state === "prepared") {
    primary = <Button variant="primary" block disabled={windowBusy} onClick={() => {
      // Synchronous in this click: popup permission does not survive awaited work.
      cleanup.current();
      setMessage("");
      cleanup.current = openClaimWindow({
        portalOrigin: __PORTAL_ORIGIN__, pollId: poll.id, keyId: poll.key.keyId,
        onChange: (next, rejected) => setWin({ state: next, rejected }),
        beginRequest: async () => {
          try { return await beginClaim(poll.id); }
          catch (error) {
            setMessage("The claim attempt could not be saved in this browser, so nothing was sent.");
            void refresh();
            throw error;
          }
        },
        onResult: async (result) => {
          const outcome = await finishClaim(poll.id, poll.key.publicJwk, result);
          setMessage(outcomeText(outcome));
          await refresh();
        },
      });
    }}>{windowBusy ? "Waiting for the portal…" : "Open claim window"}</Button>;
  } else if (open && state === "usable") {
    primary = <Button variant="primary" block type="submit" form="answers" disabled={sending}>Submit answers</Button>;
  } else if (pending) {
    primary = <Button variant="primary" block disabled={sending} onClick={() => void submit(async () => {})}>
      {sending ? "Sending…" : "Retry submission"}</Button>;
  }

  return <main className={styles.layout}>
    <section className={styles.main}>
      <div className={styles.intro}>
        <div className={styles.statusRow}>
          <StatusPlate status={poll.invalidated ? "withdrawn" : poll.status} />
          <span className={styles.public}>Public poll · anyone with the link can read these questions</span>
        </div>
        <h1 className={`${styles.title} user-text`}>{poll.title}</h1>
        {poll.description && <p className={`${styles.description} user-text`}>{poll.description}</p>}
        <div className={styles.deadline}>
          <span className={styles.deadlineText}>
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><g fill="none" stroke="#a3a3a3" strokeWidth="1.2" strokeLinecap="round">
              <circle cx="8" cy="8" r="6" /><path d="M8 4.5V8l2.5 1.5" /></g></svg>
            {open ? "Closes" : "Closed"} {deadlineText(open || !poll.closedAt ? poll.closesAt : poll.closedAt)} (your time)
          </span>
          <span className={`mono ${styles.utc}`}>{open || !poll.closedAt ? poll.closesAt : poll.closedAt}</span>
        </div>
      </div>
      {poll.invalidated && <WarningPlate>This poll was withdrawn by the operator. It must not be relied upon, and it accepts nothing further.</WarningPlate>}
      <NoticePlate title="Privacy notice">{PRIVACY_NOTICE}</NoticePlate>
      {finished ? <div className={styles.done}>
        <h2 className={styles.doneTitle}>Thanks. Your response was received.</h2>
        <p>{SUCCESS_BODY} You can close this tab. The organiser sees results only after the poll closes, and only if enough people respond.</p>
      </div> : <form id="answers" className={styles.questions} onSubmit={(event) => { event.preventDefault(); if (state === "usable") submitAnswers(); }}>
        {poll.questions.map((question, index) => <QuestionCard key={question.id} question={question} index={index}
          value={values[question.id]} disabled={frozen}
          onChange={(value) => { edited.current = true; setDraft((current) => {
            const next = { ...current };
            if (value === undefined) delete next[question.id]; else next[question.id] = value;
            return next;
          }); }} />)}
      </form>}
    </section>

    <aside className={styles.panel} aria-label="Your credential">
      <div className={styles.panelInner} data-testid="capabilities" data-state={missing === null ? "checking" : unsupported ? "unsupported" : "supported"}>
        <div className={styles.panelTop}><span className={styles.panelLabel}>THE BOOTH</span><span className="mono">{stepLabel}</span></div>
        <Booth display={display} lit={view.lit} leds={view.leds} ledge={view.ledge} cardIn={view.cardIn}
          label={`Response booth. Its display reads ${display === clock.display ? clock.label : display}.`} />
        <div className={styles.copy} aria-live="polite">
          <h2 className={styles.headline}>{view.headline}</h2>
          {unsupported
            ? <p className={styles.body}>This browser can’t claim a credential because it is missing: {missing!.join(", ")}. Use a current
              desktop Chromium or Firefox with site storage enabled.</p>
            : <p className={styles.body} data-testid="credential" data-state={state}>{view.body}</p>}
        </div>
        {!finished && !unsupported && <StepList steps={steps.map((label, i) => ({ label, state: stepStates(view.step)[i] }))} />}
        {open && (state === "none" || state === "prepared") && <WarningPlate>{LOSS_WARNING}</WarningPlate>}
        {open && state === "usable" && <WarningPlate>{SUBMIT_WARNING}</WarningPlate>}
        {primary}
        {open && state === "prepared" && <p className={styles.status}>Not signed in yet? <a href={`${__PORTAL_ORIGIN__}/signed-in`}
          target="_blank" rel="noopener noreferrer">Sign in to portal</a> in another tab, then return here to open the claim window.</p>}
        <p className={styles.status} data-testid="claim-window" data-state={win.state} data-rejected={win.rejected}>
          {WINDOW_TEXT[win.state as ClaimWindowState] ?? ""}</p>
        <p className={styles.status} data-testid="claim-message" role="status">{message}</p>
        <p className={styles.status} data-testid="submit-message" role="status">{submitMessage}</p>
        <p className={styles.footnote}>Stored only in this browser · desktop Chrome or Firefox</p>
      </div>
    </aside>
  </main>;
}
