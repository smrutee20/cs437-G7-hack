import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { isCanonicalUuidV4 } from "@iitgn-feedback/protocol";
import { missingClaimCapabilities, openClaimWindow, type ClaimWindowState } from "./claim-window";
import { SPIKE_POLL } from "./spike-poll";

const root = document.getElementById("root");
if (!root) throw new Error("Missing response root element");

const CLAIM_TEXT: Record<ClaimWindowState | "idle", string> = {
  idle: "Ready to connect to the portal claim window.",
  popup_blocked: "Your browser blocked the claim window. Allow pop-ups for this site, then choose “Open claim window” again.",
  waiting_ready: "Waiting for the claim window…",
  waiting_ack: "Connecting to the claim window…",
  connected: "Connected to the claim window. (Claiming is not implemented yet.)",
  connection_lost: "The claim window was reloaded, so the connection was closed. Open the claim window again.",
  bridge_closed: "The claim window was closed before connecting. Open the claim window again.",
};

function PollPage({ pollId }: { pollId: string }) {
  const [missing, setMissing] = useState<string[] | null>(null);
  const [claim, setClaim] = useState<{ state: ClaimWindowState | "idle"; rejected: number }>({ state: "idle", rejected: 0 });
  const cleanup = useRef<() => void>(() => {});
  useEffect(() => {
    void missingClaimCapabilities().then(setMissing);
    return () => cleanup.current();
  }, []);

  if (pollId !== SPIKE_POLL.pollId) return <main>This poll was not found.</main>;
  if (missing === null) return <main data-testid="capabilities" data-state="checking">Checking browser support…</main>;
  if (missing.length > 0) {
    return (
      <main data-testid="capabilities" data-state="unsupported">
        This browser can’t claim a credential because it is missing: {missing.join(", ")}. Use a current desktop Chromium or
        Firefox with site storage enabled.
      </main>
    );
  }
  const canOpen = ["idle", "popup_blocked", "connection_lost", "bridge_closed"].includes(claim.state);
  return (
    <main data-testid="capabilities" data-state="supported">
      <h1>Synthetic spike poll</h1>
      <button
        type="button"
        disabled={!canOpen}
        onClick={() => {
          cleanup.current();
          cleanup.current = openClaimWindow({
            portalOrigin: __PORTAL_ORIGIN__,
            pollId,
            keyId: SPIKE_POLL.keyId,
            onChange: (state, rejected) => setClaim({ state, rejected }),
          });
        }}
      >
        Open claim window
      </button>
      <p data-testid="claim-window" data-state={claim.state} data-rejected={claim.rejected}>
        {CLAIM_TEXT[claim.state]}
      </p>
    </main>
  );
}

type PublicQuestion = {id:string;type:"single_choice"|"rating"|"free_text";prompt:string;required:boolean;
  options?:{id:string;label:string}[]};
type PublicPoll = {title:string;description:string;status:"open"|"closed";invalidated:boolean;
  closesAt:string;questions:PublicQuestion[]};
function PublicPollPage({pollId}:{pollId:string}) {
  const [poll,setPoll]=useState<PublicPoll|null>(null);
  const [state,setState]=useState<"loading"|"missing"|"ready">("loading");
  useEffect(()=>{
    const abort=new AbortController();
    void fetch(`/api/v1/polls/${pollId}/public`,{credentials:"omit",cache:"no-store",signal:abort.signal})
      .then((response)=>response.ok?response.json():Promise.reject(new Error("unavailable")))
      .then((body:PublicPoll)=>{setPoll(body);setState("ready");})
      .catch(()=>{if(!abort.signal.aborted)setState("missing");});
    return ()=>abort.abort();
  },[pollId]);
  if(state==="loading") return <main>Loading public poll…</main>;
  if(state==="missing"||!poll) return <main>This poll is not available.</main>;
  return <main><h1>{poll.title}</h1><p>{poll.description}</p>
    <p>{poll.invalidated?"Poll was withdrawn.":`Poll is ${poll.status}.`}</p>
    <p>Deadline: {new Date(poll.closesAt).toLocaleString()} (local time); {poll.closesAt} (UTC).</p>
    <p>Your institutional account is checked to issue one credential. The response service does not require sign-in,
      and answers are not stored with your account identity. A credential can be used once and can be lost or shared.
      Do not include identifying details in your answers. Free text, small result categories, outside knowledge,
      and network metadata may reveal you. The platform and its infrastructure must be trusted. This is not an
      election system or a guarantee of absolute anonymity.</p>
    <p>Questions are public to anyone with this link. This synthetic demo does not issue credentials or accept answers yet.</p>
    <ol>{poll.questions.map((question)=><li key={question.id}><p>{question.prompt}{question.required?" (required)":" (optional)"}</p>
      {question.type==="single_choice"?<ul>{question.options?.map((option)=><li key={option.id}>{option.label}</li>)}</ul>:
        question.type==="rating"?<p>Rating: 1–5</p>:
          <p>Free text may identify you. Do not include identifying details.</p>}
    </li>)}</ol>
  </main>;
}

const match = /^\/p\/([^/]+)$/.exec(window.location.pathname);
createRoot(root).render(
  match && isCanonicalUuidV4(match[1]) ?
    (match[1]===SPIKE_POLL.pollId?<PollPage pollId={match[1]} />:<PublicPollPage pollId={match[1]} />) :
    <main>Response scaffold — open a poll link.</main>,
);
