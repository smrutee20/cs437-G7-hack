import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { startClaimBridge, type BridgeState } from "./claim-bridge";
import { SPIKE_POLL } from "./spike-poll";

const root = document.getElementById("root");
if (!root) throw new Error("Missing portal root element");

const BRIDGE_TEXT: Record<BridgeState, string> = {
  invalid_link: "This claim link is not valid.",
  direct_visit: "Open this window from the response page using its “Open claim window” button.",
  unknown_poll: "This poll is not available for claiming.",
  waiting_init: "Connecting to the response page…",
  connected: "Connected to the response page. (Claiming is not implemented yet.)",
};

function ClaimBridge() {
  const [view, setView] = useState<{ state: BridgeState | "starting"; rejected: number }>({ state: "starting", rejected: 0 });
  useEffect(
    () =>
      startClaimBridge({
        responseOrigin: __RESPOND_ORIGIN__,
        lookupKeyId: (pollId) => (pollId === SPIKE_POLL.pollId ? SPIKE_POLL.keyId : undefined),
        onChange: (state, rejected) => setView({ state, rejected }),
      }),
    [],
  );
  return (
    <main>
      <h1>Claim window</h1>
      <p data-testid="bridge" data-state={view.state} data-rejected={view.rejected}>
        {view.state === "starting" ? "Starting…" : BRIDGE_TEXT[view.state]}
      </p>
    </main>
  );
}

createRoot(root).render(
  window.location.pathname === "/claim-bridge" ? <ClaimBridge /> : <main>Portal scaffold — no sign-in or poll features yet.</main>,
);
