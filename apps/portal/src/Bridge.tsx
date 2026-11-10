// The claim-bridge popup: the "issuing desk". It shows the signed-in account
// next to the poll title and asks for explicit confirmation. The press
// animation starts only after that confirmation and never delays the request.
import { useEffect, useRef, useState } from "react";
import { BadgeIcon, Button, buttonClass, MarqueeLights, prefersReducedMotion, Press } from "@iitgn-feedback/ui";
import { postClaim, startClaimBridge, type BridgeContext, type BridgeController, type BridgeView } from "./claim-bridge";
import styles from "./Portal.module.css";

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

const REFUSED: Record<string, string> = {
  not_eligible: "This account is not on the poll's eligibility list. Nothing was stamped and your claim was not used.",
  claim_consumed: "This account has already claimed its one credential for this poll.",
  claim_consumed_no_credential: "Your claim was used, but the portal could not stamp the envelope. No replacement can be issued.",
  rate_limited: "Too many attempts. Wait a minute and try again from the response page. Nothing was stamped.",
  capacity_unavailable: "The portal is busy. Nothing was stamped; try again shortly from the response page.",
  login_required: "You are not signed in to the portal. Sign in in another tab, then return to the response tab and choose “Open claim window” again. Nothing was stamped.",
  poll_closed: "This poll has closed. Nothing was stamped.",
  poll_withdrawn: "This poll was withdrawn. Nothing was stamped.",
  not_attempted: "Cancelled. Nothing was stamped and your claim was not used.",
  temporarily_unavailable: "The outcome is unknown. Do not start another claim; the response page keeps an explicit record.",
};

function bridgeText(view: BridgeView): string {
  switch (view.state) {
    case "invalid_link": return "This claim link is not valid.";
    case "direct_visit": return "Open this window from the response page using its “Open claim window” button.";
    case "unknown_poll": return "This poll is not available for claiming.";
    case "loading": return "Loading…";
    case "waiting_init": return "Connecting to the response page…";
    case "connected": return view.signedIn ? "Connected. Waiting for the response page’s sealed envelope…"
      : "You are not signed in to the portal. Sign in in another tab, then open the claim window again from the response page.";
    case "confirming": return "This uses your one claim for this poll. The portal checks your account and stamps the envelope. It never sees the credential inside.";
    case "claiming": return "Stamping…";
    case "result_sent": return view.outcome === "signed" ? "Stamped. Sending it back to the response page and waiting for it to confirm storage…"
      : REFUSED[view.outcome ?? ""] ?? "The portal refused the request.";
    case "expired": return "The response page did not confirm in time. This window’s copy of the result has been erased.";
    case "stored": return view.outcome === "signed" ? "Stamped and stored on the response page. You can close this window."
      : `${REFUSED[view.outcome ?? ""] ?? "Nothing was stamped."} You can close this window.`;
  }
}

export function ClaimBridge() {
  const [view, setView] = useState<BridgeView | null>(null);
  const controller = useRef<BridgeController | null>(null);
  const confirmedAt = useRef(0);
  const latest = useRef<BridgeView | null>(null);
  useEffect(() => {
    controller.current = startClaimBridge({
      responseOrigin: __RESPOND_ORIGIN__, loadContext, submitClaim: postClaim,
      onChange: (next) => { latest.current = next; setView({ ...next }); },
      // Let a successful stamp finish (2.4 s from confirmation) before the window closes.
      closeDelayMs: () => latest.current?.outcome === "signed" && !prefersReducedMotion()
        ? confirmedAt.current + 3000 - Date.now() : 0,
    });
    return () => controller.current?.cleanup();
  }, []);
  const state = view?.state ?? "starting";
  const signed = view?.outcome === "signed";
  const press = state === "claiming" ? "stamping" : signed && (state === "result_sent" || state === "stored") ? "stamped" : "idle";
  const waiting = state === "loading" || state === "waiting_init" || state === "connected" || state === "starting";
  return <main className={styles.bridge}>
    <span className={styles.bridgeLabel}>ISSUING DESK · PORTAL</span>
    {view?.signedIn && view.email && <div className={styles.badge}>
      <BadgeIcon size={30} />
      <div><div className={styles.badgeHint}>Signed in as</div><div className={styles.badgeEmail}>{view.email}</div></div>
    </div>}
    <div className={styles.pressBox}>
      <Press mode={press} label={press === "stamped" ? "Stamp press: your envelope was stamped and slid out" : "Stamp press with your sealed envelope under the stamp"} />
    </div>
    <div>
      <h1 className={styles.bridgeTitle}>{view?.state === "confirming" && view.title
        ? <>Stamp your envelope for “<span className="user-text">{view.title}</span>”?</>
        : view?.outcome === "signed" ? "Envelope stamped" : view?.outcome ? "Not stamped" : "Claim window"}</h1>
      <p className={styles.bridgeText} data-testid="bridge" data-state={state} data-rejected={view?.rejected ?? 0}>
        {view ? bridgeText(view) : "Starting…"}</p>
    </div>
    {waiting && <MarqueeLights active />}
    {state === "confirming" && <div className={styles.actions}>
      <Button variant="primary" className={styles.grow} onClick={() => { confirmedAt.current = Date.now(); controller.current?.confirm(); }}>Stamp my envelope</Button>
      <Button variant="secondary" onClick={() => controller.current?.cancel()}>Cancel</Button>
    </div>}
    {state === "claiming" && <Button variant="primary" disabled block>Stamping…</Button>}
    {state === "stored" && view?.outcome === "login_required" && <div className={styles.actions}>
      <a className={buttonClass("primary")} href="/signed-in" target="_blank" rel="noopener noreferrer">Sign in to portal</a>
    </div>}
  </main>;
}
