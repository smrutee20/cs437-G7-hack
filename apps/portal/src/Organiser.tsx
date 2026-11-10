import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button, buttonClass, Card, NoticePlate, StatusPlate, WarningPlate } from "@iitgn-feedback/ui";
import { parseEligibilityImportWithMetadata } from "./eligibility-import";
import { ResultsPanel, type Question, type Results, type ResultsView } from "./Results";
import styles from "./Portal.module.css";

export type Session = { user: { id: string; email: string; isOrganiser: boolean }; csrfToken: string };
type Summary = { id: string; title: string; status: "draft" | "open" | "closed"; invalidated: boolean; revision: number; closesAt: string;
  closedAt: string | null; eligibilityRetention: "retained" | "purged"; policy: { version: number; minResponses: number; minAnswersPerQuestion: number } };
type Poll = Summary & { description: string; questions: Question[]; eligibilityEmails: string[] | null };

export const ORGANISER_WARNINGS = [
  "Questions are publicly readable by anyone with the invitation link; eligibility does not make them confidential.",
  "Free text can identify its authors.",
  "New polls show results after at least one response; a single eligible person or answer may be identifiable to the organiser.",
  "Opening freezes the title, description, questions, eligibility, deadline, signing key and publication policy. Nothing can change afterwards.",
];
const blankQuestion = (): Question => ({ id: crypto.randomUUID(), type: "rating", prompt: "", required: true });
function localDate(instant: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${instant.getFullYear()}-${pad(instant.getMonth() + 1)}-${pad(instant.getDate())}T${pad(instant.getHours())}:${pad(instant.getMinutes())}`;
}
const when = (instant: string) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(instant));
const ERROR_TEXT: Record<string, string> = {
  validation_failed: "Some fields need attention.", draft_conflict: "This draft changed elsewhere. Reload it before saving again.",
  invalid_state: "That isn't possible in the poll's current state.", rate_limited: "You have created the maximum number of drafts for today.",
  forbidden: "This account is not allowed to do that.", csrf_failed: "Your session check failed. Reload the page and try again.",
  authentication_required: "Your session ended. Sign in again.", not_found: "That poll is not available.",
  capacity_unavailable: "The service is busy. Try again shortly.", temporarily_unavailable: "The service is unavailable. Try again shortly.",
};
const FIELD_TEXT: Record<string, string> = { eligibilityEmails: "Eligibility list", retainedPolls: "You already keep the maximum of 50 polls; delete drafts you no longer need.",
  closesAt: "Deadline", title: "Poll title", questions: "Questions" };

/** In-page modal for irreversible actions. A typed word is required for red (danger) actions. */
function ConfirmDialog({ title, children, confirmLabel, variant, typed, onConfirm, onCancel }: {
  title: string; children: ReactNode; confirmLabel: string; variant: "primary" | "danger"; typed?: string;
  onConfirm: () => void; onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState("");
  useEffect(() => { ref.current?.showModal(); return () => ref.current?.close(); }, []);
  const ready = !typed || text.trim() === typed;
  return <dialog ref={ref} className={styles.dialog} aria-labelledby="confirm-title" onCancel={(event) => { event.preventDefault(); onCancel(); }}>
    <form method="dialog" className={styles.dialogBody} onSubmit={(event) => { event.preventDefault(); if (ready) onConfirm(); }}>
      <h2 id="confirm-title" className={styles.dialogTitle}>{title}</h2>
      <div className={styles.dialogText}>{children}</div>
      {typed && <label className={styles.field}>Type {typed} to confirm
        <input className={styles.input} value={text} autoComplete="off" onChange={(event) => setText(event.target.value)} /></label>}
      <div className={styles.dialogActions}>
        <Button variant={variant} type="submit" disabled={!ready}>{confirmLabel}</Button>
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  </dialog>;
}

export function OrganiserApp({ session, onSignedOut }: { session: Session; onSignedOut: () => void }) {
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [polls, setPolls] = useState<Summary[]>([]);
  const [active, setActive] = useState<Poll | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [deadline, setDeadline] = useState(() => localDate(new Date(Date.now() + 86_400_000)));
  const [eligibility, setEligibility] = useState("");
  const [questions, setQuestions] = useState<Question[]>([blankQuestion()]);
  const [preview, setPreview] = useState(false);
  const [results, setResults] = useState<ResultsView | null>(null);
  const [confirm, setConfirm] = useState<{ poll: Summary; action: "open" | "close" | "delete" } | null>(null);

  const refreshPolls = async () => {
    const response = await fetch("/api/v1/polls?limit=50", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error("Poll list unavailable");
    setPolls((await response.json() as { items: Summary[] }).items);
  };
  useEffect(() => { if (session.user.isOrganiser) void refreshPolls().catch(() => setError("Poll list unavailable")); }, [session]);
  const mutate = async (path: string, method: "POST" | "PUT" | "DELETE", body: unknown, sourceRows: number[] = []): Promise<Poll | null> => {
    const response = await fetch(path, { method, credentials: "same-origin", cache: "no-store",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken }, body: JSON.stringify(body) });
    if (response.status === 204) return null;
    if (!response.ok) {
      const result = await response.json().catch(() => ({ error: { code: "temporarily_unavailable" } })) as
        { error?: { code?: string; field?: string; rowNumbers?: number[] } };
      const code = result.error?.code ?? "temporarily_unavailable";
      const rows = result.error?.rowNumbers;
      const field = result.error?.field;
      throw new Error(rows?.length ? `Eligibility list: fix line${rows.length === 1 ? "" : "s"} ${rows.map((row) => sourceRows[row - 1] ?? row).join(", ")}. ` +
        "Each must be an institutional @iitgn.ac.in address; nothing was imported."
        : field === "retainedPolls" ? FIELD_TEXT.retainedPolls
          : `${ERROR_TEXT[code] ?? "The request failed."}${field && FIELD_TEXT[field] ? ` (${FIELD_TEXT[field]})` : field ? ` (${field})` : ""}`);
    }
    return await response.json() as Poll;
  };
  const perform = async (action: () => Promise<void>) => {
    setError(""); setNotice(""); setBusy(true);
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Operation unavailable"); }
    finally { setBusy(false); }
  };
  const logout = () => void perform(async () => {
    const response = await fetch("/api/v1/auth/logout", { method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken }, body: "{}" });
    if (!response.ok) throw new Error("Sign-out unavailable");
    onSignedOut();
  });
  const reset = () => { setActive(null); setTitle(""); setDescription(""); setResults(null);
    setDeadline(localDate(new Date(Date.now() + 86_400_000))); setEligibility(""); setQuestions([blankQuestion()]); setPreview(false); setNotice(""); };
  const choose = (id: string) => void perform(async () => {
    const response = await fetch(`/api/v1/polls/${id}`, { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error("Poll unavailable");
    const poll = await response.json() as Poll;
    setResults(null); setActive(poll); setTitle(poll.title); setDescription(poll.description);
    setDeadline(localDate(new Date(poll.closesAt))); setEligibility(poll.eligibilityEmails?.join("\n") ?? "");
    setQuestions(poll.questions); setPreview(false);
  });
  const save = (event: FormEvent) => {
    event.preventDefault();
    void perform(async () => {
      const { emails, sourceRows } = parseEligibilityImportWithMetadata(eligibility);
      const date = new Date(deadline);
      if (!Number.isFinite(date.getTime())) throw new Error("Enter a valid deadline.");
      const draft = { title, description, closesAt: date.toISOString(), questions, eligibilityEmails: emails };
      const poll = active ? await mutate(`/api/v1/polls/${active.id}`, "PUT", { revision: active.revision, draft }, sourceRows)
        : await mutate("/api/v1/polls", "POST", draft, sourceRows);
      setActive(poll); setNotice(`Draft saved. Revision ${poll!.revision}.`); await refreshPolls();
    });
  };
  const transition = (poll: Summary, action: "open" | "close" | "delete") => {
    setConfirm(null);
    void perform(async () => {
      if (action === "delete") {
        await mutate(`/api/v1/polls/${poll.id}`, "DELETE", {});
        if (active?.id === poll.id) reset();
        await refreshPolls(); setNotice("Draft deleted.");
        return;
      }
      const updated = (await mutate(`/api/v1/polls/${poll.id}/${action}`, "POST", action === "open" ? { revision: poll.revision } : {}))!;
      if (active?.id === poll.id) setActive(updated);
      await refreshPolls(); setNotice(`Poll is ${updated.status}.`);
    });
  };
  const viewResults = (poll: Summary) => void perform(async () => {
    const owned = await (await fetch(`/api/v1/polls/${poll.id}`, { credentials: "same-origin", cache: "no-store" })).json() as Poll;
    const response = await fetch(`/api/v1/polls/${poll.id}/results`, { credentials: "same-origin", cache: "no-store" });
    const base = { title: owned.title, questions: owned.questions, closedAt: owned.closedAt, policy: owned.policy };
    setActive(null);
    if (response.ok) { setResults({ ...base, kind: "loaded", results: await response.json() as Results }); return; }
    const code = (await response.json().catch(() => ({})) as { error?: { code?: string } }).error?.code;
    setResults({ ...base, kind: "message", withdrawn: code === "poll_withdrawn",
      text: code === "results_not_closed" ? "Results are available only after the poll closes."
        : code === "poll_withdrawn" ? "This poll was withdrawn. Its results are permanently withheld." : "Results are unavailable." });
  });
  const updateQuestion = (index: number, change: Partial<Question>) => setQuestions((current) => current.map((question, i) =>
    i === index ? { ...question, ...change } : question));
  const utc = Number.isFinite(new Date(deadline).getTime()) ? new Date(deadline).toISOString() : "Invalid";
  const editable = !active || active.status === "draft";
  const lineCount = eligibility.split(/\r?\n/).filter((line) => line.trim()).length;

  return <main className={styles.workspace}>
    <div className={styles.titleRow}>
      <div><h1 className={styles.pageTitle}>Your polls</h1><p className={styles.meta}>Signed in as {session.user.email}</p></div>
      <div className={styles.actions}>
        {session.user.isOrganiser && <Button variant="primary" onClick={reset}>New poll</Button>}
        <Button variant="secondary" onClick={logout}>Sign out</Button>
      </div>
    </div>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <p role="status" className={styles.notice}>{notice}</p>
    {!session.user.isOrganiser ? <Card><h2 className={styles.cardTitle}>This account is not provisioned as an organiser</h2>
      <p className={styles.meta}>To respond to a poll, return to the poll's tab on the response site and choose “Open claim window”.</p></Card> : <>
      <ul className={styles.pollList} aria-label="Owned polls">
        {polls.length === 0 && <li className={styles.empty}>No polls yet. Choose “New poll” to start a draft.</li>}
        {polls.map((poll) => <li key={poll.id} className={styles.pollItem}>
          <StatusPlate status={poll.invalidated ? "withdrawn" : poll.status} />
          <div className={styles.pollMain}>
            <button type="button" className={`${styles.pollTitle} user-text`} onClick={() => choose(poll.id)}>{poll.title}</button>
            <span className={styles.meta}>{poll.status === "closed" ? `Closed ${poll.closedAt ? when(poll.closedAt) : ""}` : `Closes ${when(poll.closesAt)}`}
              {poll.eligibilityRetention === "purged" ? " · eligibility purged" : ""}</span>
          </div>
          <div className={styles.pollActions}>
            {poll.status === "draft" && <><Button variant="primary" size="small" disabled={busy} onClick={() => setConfirm({ poll, action: "open" })}>Open poll</Button>
              <Button variant="quiet" size="small" disabled={busy} onClick={() => setConfirm({ poll, action: "delete" })}>Delete draft</Button></>}
            {poll.status === "open" && <Button variant="danger" size="small" disabled={busy} onClick={() => setConfirm({ poll, action: "close" })}>Close poll</Button>}
            {poll.status === "closed" && <Button variant="secondary" size="small" disabled={busy} onClick={() => viewResults(poll)}>View results</Button>}
            {<a className={buttonClass("quiet", "small")} href={`${__RESPOND_ORIGIN__}/p/${poll.id}`} target="_blank" rel="noopener noreferrer">Public poll link</a>}
          </div>
        </li>)}
      </ul>
      {results ? <ResultsPanel view={results} onBack={() => setResults(null)} /> : <form onSubmit={save} className={styles.editor}>
        <fieldset disabled={busy} className={styles.editorFields}>
          <legend className={styles.editorTitle}>{active ? `Edit ${active.title}` : "Create draft"}</legend>
          {!editable && <WarningPlate>This poll is {active?.status}. Its content, eligibility and deadline are frozen.</WarningPlate>}
          <NoticePlate title="Before you open a poll"><ul className={styles.warnList}>{ORGANISER_WARNINGS.map((text) => <li key={text}>{text}</li>)}</ul></NoticePlate>
          <label className={styles.field}>Poll title<input className={styles.input} value={title} maxLength={480} onChange={(event) => setTitle(event.target.value)} required /></label>
          <label className={styles.field}>Description<textarea className={styles.textarea} rows={3} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
          <div className={styles.fieldRow}>
            <label className={styles.field}>Deadline (local time)<input className={styles.input} type="datetime-local" value={deadline} onChange={(event) => setDeadline(event.target.value)} required /></label>
            <p className={styles.meta}>Exact UTC deadline: <span className="mono">{utc}</span><br />Must be 10 minutes to 30 days after opening.</p>
          </div>
          <label className={styles.field}>Eligibility emails<textarea className={`${styles.textarea} mono`} rows={8} value={eligibility}
            onChange={(event) => setEligibility(event.target.value)} required /></label>
          <p className={styles.meta}>Paste at least one institutional address, one per line, or a single-column CSV with an optional “email” header.
            {lineCount > 0 ? ` ${lineCount} line${lineCount === 1 ? "" : "s"} entered.` : ""} The exact list is visible only to you and is purged seven days after closure.</p>
          <h3 className={styles.sectionTitle}>Questions</h3>
          {questions.map((question, index) => <fieldset key={question.id} className={styles.questionEditor}>
            <legend className={styles.qLegend}>Question {index + 1}</legend>
            <label className={styles.field}>Question {index + 1} prompt<input className={styles.input} value={question.prompt}
              onChange={(event) => updateQuestion(index, { prompt: event.target.value })} required /></label>
            <div className={styles.fieldRow}>
              <label className={styles.field}>Type<select className={styles.input} value={question.type} onChange={(event) => {
                const type = event.target.value as Question["type"];
                updateQuestion(index, { type, required: type === "free_text" ? false : question.required,
                  options: type === "single_choice" ? (question.options ?? [{ id: crypto.randomUUID(), label: "" }, { id: crypto.randomUUID(), label: "" }]) : undefined });
              }}><option value="rating">Rating 1–5</option><option value="single_choice">Single choice</option><option value="free_text">Optional free text</option></select></label>
              {question.type !== "free_text" && <label className={styles.check}><input type="checkbox" checked={question.required}
                onChange={(event) => updateQuestion(index, { required: event.target.checked })} />Required</label>}
            </div>
            {question.type === "free_text" && <WarningPlate>Free text can identify its author. It is always optional.</WarningPlate>}
            {question.type === "single_choice" && <div className={styles.optionsEditor}>{question.options?.map((option, optionIndex) =>
              <label key={option.id} className={styles.field}>Option {optionIndex + 1}<input className={styles.input} value={option.label}
                onChange={(event) => updateQuestion(index, { options: question.options?.map((item, i) => i === optionIndex ? { ...item, label: event.target.value } : item) })} required /></label>)}
              <div><Button size="small" disabled={(question.options?.length ?? 0) >= 10}
                onClick={() => updateQuestion(index, { options: [...(question.options ?? []), { id: crypto.randomUUID(), label: "" }] })}>Add option</Button></div>
            </div>}
            <div><Button variant="quiet" size="small" disabled={questions.length === 1}
              onClick={() => setQuestions((current) => current.filter((_, i) => i !== index))}>Remove question</Button></div>
          </fieldset>)}
          <div className={styles.actions}>
            <Button disabled={questions.length >= 20} onClick={() => setQuestions((current) => [...current, blankQuestion()])}>Add question</Button>
            <Button onClick={() => setPreview((shown) => !shown)}>Preview synthetic answers</Button>
          </div>
          {preview && <section className={styles.preview} aria-labelledby="preview-title">
            <h3 id="preview-title" className={styles.sectionTitle}>Synthetic preview</h3>
            <p className={styles.meta}>Example answers below are invented and never sent to an API. Preview cannot claim a credential or create a response.</p>
            <h4 className={`${styles.previewTitle} user-text`}>{title || "Untitled poll"}</h4>
            {description && <p className="user-text">{description}</p>}
            {questions.map((question, index) => <div key={question.id} className={styles.previewQuestion}>
              <p className="user-text"><span className="mono">Q{index + 1}</span> {question.prompt}</p>
              <p className={styles.meta}>{question.type === "rating" ? "Sample rating: 3 (synthetic, not saved)"
                : question.type === "single_choice" ? `Sample choice: ${question.options?.[0]?.label || "Option"} (synthetic, not saved)`
                  : "Sample text (synthetic, not saved)"}</p>
            </div>)}
          </section>}
          <div className={styles.actions}>
            <Button variant="primary" type="submit" disabled={busy || !editable}>{active ? "Save changes" : "Save draft"}</Button>
          </div>
        </fieldset>
      </form>}
    </>}
    {confirm?.action === "open" && <ConfirmDialog title={`Open “${confirm.poll.title}”?`} confirmLabel="Open poll" variant="primary"
      onCancel={() => setConfirm(null)} onConfirm={() => transition(confirm.poll, "open")}>
      <p>Opening is irreversible. Once open:</p><ul className={styles.warnList}>{ORGANISER_WARNINGS.map((text) => <li key={text}>{text}</li>)}</ul>
    </ConfirmDialog>}
    {confirm?.action === "close" && <ConfirmDialog title={`Close “${confirm.poll.title}” now?`} confirmLabel="Close poll now" variant="danger" typed="CLOSE"
      onCancel={() => setConfirm(null)} onConfirm={() => transition(confirm.poll, "close")}>
      <p>Closing is irreversible: no further claims or responses are accepted. Results are withheld if fewer than {confirm.poll.policy.minResponses} {confirm.poll.policy.minResponses === 1 ? "response was" : "responses were"} received.
        Live response or claim counts are never shown. For small polls, answers may identify participants.</p>
    </ConfirmDialog>}
    {confirm?.action === "delete" && <ConfirmDialog title={`Delete the draft “${confirm.poll.title}”?`} confirmLabel="Delete draft" variant="danger" typed="DELETE"
      onCancel={() => setConfirm(null)} onConfirm={() => transition(confirm.poll, "delete")}>
      <p>The draft, its eligibility list and its signing key are destroyed. This cannot be undone.</p>
    </ConfirmDialog>}
  </main>;
}
