import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { isCanonicalUuidV4 } from "@iitgn-feedback/protocol";
import { beginClaim, finishClaim, prepareCredential, type ClaimOutcome } from "./claim-flow";
import { missingClaimCapabilities, openClaimWindow, type ClaimWindowState } from "./claim-window";
import { onRecordChange, sweep, type CredentialRecord, type CredentialState } from "./credential-store";

const root = document.getElementById("root");
if (!root) throw new Error("Missing response root element");

type PublicQuestion = { id: string; type: "single_choice" | "rating" | "free_text"; prompt: string; required: boolean;
  options?: { id: string; label: string }[] };
type PublicPoll = { id: string; title: string; description: string; status: "open" | "closed"; invalidated: boolean;
  closesAt: string; questions: PublicQuestion[]; key: { keyId: string; keyVersion: 1; publicJwk: unknown } };

const WINDOW_TEXT: Partial<Record<ClaimWindowState, string>> = {
  popup_blocked: "Your browser blocked the claim window. Allow pop-ups for this site, then choose “Open claim window” again.",
  waiting_ready: "Waiting for the claim window…",
  waiting_ack: "Connecting to the claim window…",
  connected: "Connected. Saving the claim attempt in this browser…",
  request_sent: "Confirm the claim in the portal window.",
  finishing: "Checking and storing the credential…",
  connection_lost: "The claim window was reloaded, so the connection was closed.",
  bridge_closed: "The claim window closed.",
};
const RECORD_TEXT: Record<CredentialState | "none", string> = {
  none: "No credential is stored in this browser for this poll.",
  prepared: "A credential request is prepared in this browser. Open the claim window to have it signed.",
  claim_sent: "A claim from this browser is in progress or its outcome is unknown. No new claim will be started from this browser.",
  usable: "Your credential is stored in this browser. Submitting answers is not available in this synthetic build yet.",
  claim_consumed: "A credential for your account on this poll has already been claimed, or a claim was used up without " +
    "delivering a credential. This browser cannot respond to this poll.",
  claim_uncertain: "An earlier claim from this browser has an unknown outcome, so it cannot claim again. This browser cannot " +
    "respond to this poll.",
};
const RETRY_TEXT: Record<string, string> = {
  not_attempted: "No claim was made. You can open the claim window again.",
  login_required: "Sign in to the portal in another tab, then open the claim window again. No claim was made.",
  not_eligible: "This account is not on this poll's eligibility list. No claim was made.",
  rate_limited: "Too many claim attempts. Wait a minute, then try again. No claim was made.",
  capacity_unavailable: "The service is busy. No claim was made; try again shortly.",
};
function outcomeText(outcome: ClaimOutcome): string {
  switch (outcome.kind) {
    case "usable": return "Credential received, verified and stored in this browser.";
    case "invalid_signature": return "The claim window returned a signature that did not verify. This browser cannot respond.";
    case "retry": return RETRY_TEXT[outcome.code] ?? "The portal refused the request. No claim was made.";
    case "consumed": return outcome.code === "claim_consumed_no_credential"
      ? "A credential was claimed but could not be issued. This browser cannot respond."
      : "A credential for your account on this poll has already been claimed.";
    case "closed": return "This poll is closed or withdrawn, so nothing can be claimed.";
    case "uncertain": return "The outcome of this claim is unknown. Do not start another claim; this page will mark the " +
      "attempt as uncertain if no result arrives.";
  }
}

function ClaimPanel({ poll }: { poll: PublicPoll }) {
  const open = poll.status === "open" && !poll.invalidated;
  const [missing, setMissing] = useState<string[] | null>(null);
  const [record, setRecord] = useState<CredentialRecord | null | undefined>(undefined);
  const [win, setWin] = useState<{ state: ClaimWindowState | "idle"; rejected: number }>({ state: "idle", rejected: 0 });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const cleanup = useRef<() => void>(() => {});

  const refresh = useCallback(async () => {
    try {
      setRecord(await sweep(poll.id, { open }));
    } catch {
      setMessage("This browser's credential storage is unavailable.");
    }
  }, [poll.id, open]);
  useEffect(() => {
    void missingClaimCapabilities().then(setMissing);
    return () => cleanup.current();
  }, []);
  useEffect(() => {
    if (!missing || missing.length > 0) return;
    void refresh();
    const stop = onRecordChange(poll.id, () => void refresh());
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => { stop(); window.clearInterval(timer); };
  }, [missing, poll.id, refresh]);

  if (missing === null) return <section data-testid="capabilities" data-state="checking">Checking browser support…</section>;
  if (missing.length > 0) {
    return (
      <section data-testid="capabilities" data-state="unsupported">
        This browser can’t claim a credential because it is missing: {missing.join(", ")}. Use a current desktop Chromium or
        Firefox with site storage enabled.
      </section>
    );
  }
  const state = record === undefined ? "loading" : record?.state ?? "none";
  const windowBusy = !["idle", "popup_blocked", "connection_lost", "bridge_closed", "not_sent", "done"].includes(win.state);
  return (
    <section data-testid="capabilities" data-state="supported">
      <p data-testid="credential" data-state={state}>{state === "loading" ? "Loading…" : RECORD_TEXT[state]}</p>
      {open && state === "none" && (
        <button type="button" disabled={busy} onClick={() => {
          setBusy(true);
          setMessage("");
          prepareCredential(poll)
            .catch(() => setMessage("A credential request could not be saved in this browser. Nothing was sent."))
            .finally(() => { setBusy(false); void refresh(); });
        }}>Prepare credential</button>
      )}
      {open && state === "prepared" && (
        <button type="button" disabled={windowBusy} onClick={() => {
          // Synchronous in this click: popup permission does not survive awaited work.
          cleanup.current();
          setMessage("");
          cleanup.current = openClaimWindow({
            portalOrigin: __PORTAL_ORIGIN__,
            pollId: poll.id,
            keyId: poll.key.keyId,
            onChange: (next, rejected) => setWin({ state: next, rejected }),
            beginRequest: async () => {
              try {
                return await beginClaim(poll.id);
              } catch (error) {
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
        }}>Open claim window</button>
      )}
      <p data-testid="claim-window" data-state={win.state} data-rejected={win.rejected}>{WINDOW_TEXT[win.state as ClaimWindowState] ?? ""}</p>
      <p data-testid="claim-message" role="status">{message}</p>
    </section>
  );
}

function PollPage({ pollId }: { pollId: string }) {
  const [poll, setPoll] = useState<PublicPoll | null>(null);
  const [state, setState] = useState<"loading" | "missing" | "ready">("loading");
  useEffect(() => {
    const abort = new AbortController();
    void fetch(`/api/v1/polls/${pollId}/public`, { credentials: "omit", cache: "no-store", signal: abort.signal })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("unavailable")))
      .then((body: PublicPoll) => { setPoll(body); setState("ready"); })
      .catch(() => { if (!abort.signal.aborted) setState("missing"); });
    return () => abort.abort();
  }, [pollId]);
  if (state === "loading") return <main>Loading public poll…</main>;
  if (state === "missing" || !poll) return <main>This poll is not available.</main>;
  return <main><h1>{poll.title}</h1><p>{poll.description}</p>
    <p>{poll.invalidated ? "Poll was withdrawn." : `Poll is ${poll.status}.`}</p>
    <p>Deadline: {new Date(poll.closesAt).toLocaleString()} (local time); {poll.closesAt} (UTC).</p>
    <p>Your institutional account is checked to issue one credential. The response service does not require sign-in,
      and answers are not stored with your account identity. A credential can be used once and can be lost or shared.
      Do not include identifying details in your answers. Free text, small result categories, outside knowledge,
      and network metadata may reveal you. The platform and its infrastructure must be trusted. This is not an
      election system or a guarantee of absolute anonymity.</p>
    <p>Your credential is kept only in this browser’s storage. Clearing site data, private browsing, or losing this device
      loses it, and it cannot be re-issued. Do not claim right at the deadline.</p>
    <ClaimPanel poll={poll} />
    <ol>{poll.questions.map((question) => <li key={question.id}><p>{question.prompt}{question.required ? " (required)" : " (optional)"}</p>
      {question.type === "single_choice" ? <ul>{question.options?.map((option) => <li key={option.id}>{option.label}</li>)}</ul> :
        question.type === "rating" ? <p>Rating: 1–5</p> :
          <p>Free text may identify you. Do not include identifying details.</p>}
    </li>)}</ol>
  </main>;
}

const match = /^\/p\/([^/]+)$/.exec(window.location.pathname);
createRoot(root).render(
  match && isCanonicalUuidV4(match[1]) ? <PollPage pollId={match[1]} /> : <main>Response scaffold — open a poll link.</main>,
);
