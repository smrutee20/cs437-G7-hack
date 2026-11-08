import "@iitgn-feedback/ui/styles.css";
import { createRoot } from "react-dom/client";
import { isCanonicalUuidV4 } from "@iitgn-feedback/protocol";
import { NoSignInChip, NotFound, SiteHeader } from "@iitgn-feedback/ui";
import { PollPage } from "./PollPage";

const root = document.getElementById("root");
if (!root) throw new Error("Missing response root element");
const match = /^\/p\/([^/]+)$/.exec(window.location.pathname);

createRoot(root).render(<>
  <SiteHeader site="Response site"><NoSignInChip /></SiteHeader>
  {match && isCanonicalUuidV4(match[1]) ? <PollPage pollId={match[1]} /> : <NotFound>
    <p>This is the anonymous response site. Open the poll link your organiser shared; it looks like <span className="mono">/p/…</span>.</p>
  </NotFound>}
</>);
