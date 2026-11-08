import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { postClaim, startClaimBridge, type BridgeContext, type BridgeController, type BridgeView } from "./claim-bridge";
import { OrganiserApp } from "./organiser";

const root = document.getElementById("root");
if (!root) throw new Error("Missing portal root element");

async function loadContext(pollId: string): Promise<BridgeContext> {
  try {
    const context = await fetch(`/api/v1/polls/${pollId}/claim-context`, { credentials: "same-origin", cache: "no-store" });
    if (context.status === 401) return { kind: "login_required" };
    if (!context.ok) return { kind: "unknown" };
    const poll = await context.json();
    if (poll.status !== "open" || poll.invalidated) return { kind: "unknown" };
    const session = await fetch("/api/v1/session", { credentials: "same-origin", cache: "no-store" });
    if (session.status === 401) return { kind: "login_required" };
    if (!session.ok) return { kind: "unknown" };
    const { user, csrfToken } = await session.json();
    return { kind: "ready", keyId: poll.key.keyId, title: poll.title, email: user.email, csrfToken };
  } catch {
    return { kind: "unknown" };
  }
}

function bridgeText(view: BridgeView): string {
  switch (view.state) {
    case "invalid_link": return "This claim link is not valid.";
    case "direct_visit": return "Open this window from the response page using its “Open claim window” button.";
    case "unknown_poll": return "This poll is not available for claiming.";
    case "loading": return "Loading…";
    case "waiting_init": return "Connecting to the response page…";
    case "connected": return view.signedIn ? "Connected. Waiting for the response page’s request…"
      : "You are not signed in to the portal. Sign in in another tab, then open the claim window again from the response page.";
    case "confirming": return `Claim one anonymous credential for “${view.title}” as ${view.email}? Your account can claim only once for this poll.`;
    case "claiming": return "Claiming…";
    case "result_sent": return "Result sent to the response page. Waiting for it to confirm storage…";
    case "expired": return "The response page did not confirm in time. This window’s copy of the result has been erased.";
    case "stored": return "Stored. You can close this window.";
  }
}

function ClaimBridge() {
  const [view, setView] = useState<BridgeView | null>(null);
  const controller = useRef<BridgeController | null>(null);
  useEffect(() => {
    controller.current = startClaimBridge({
      responseOrigin: __RESPOND_ORIGIN__, loadContext, submitClaim: postClaim, onChange: (next) => setView({ ...next }),
    });
    return () => controller.current?.cleanup();
  }, []);
  return (
    <main>
      <h1>Claim window</h1>
      <p data-testid="bridge" data-state={view?.state ?? "starting"} data-rejected={view?.rejected ?? 0}>
        {view ? bridgeText(view) : "Starting…"}
      </p>
      {view?.state === "confirming" && <div>
        <button type="button" onClick={() => controller.current?.confirm()}>Claim credential</button>
        <button type="button" onClick={() => controller.current?.cancel()}>Cancel</button>
      </div>}
    </main>
  );
}

createRoot(root).render(
  window.location.pathname === "/claim-bridge" ? <ClaimBridge /> : <OrganiserApp />,
);
