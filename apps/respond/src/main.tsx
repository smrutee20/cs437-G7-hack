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

const match = /^\/p\/([^/]+)$/.exec(window.location.pathname);
createRoot(root).render(
  match && isCanonicalUuidV4(match[1]) ? <PollPage pollId={match[1]} /> : <main>Response scaffold — open a poll link.</main>,
);
