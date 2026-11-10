import "@iitgn-feedback/ui/styles.css";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button, buttonClass, Card, IdentityChip, NotFound, Press, SiteHeader, WarningPlate } from "@iitgn-feedback/ui";
import { About } from "./About";
import { ClaimBridge } from "./Bridge";
import { OrganiserApp, type Session } from "./Organiser";
import styles from "./Portal.module.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing portal root element");
/** Synthetic sign-in exists only in the dev server and the separate demo build; production builds exclude it. */
const SYNTHETIC = import.meta.env.DEV || import.meta.env.MODE === "demo";

function useSession() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [error, setError] = useState("");
  const refresh = async () => {
    try {
      const response = await fetch("/api/v1/session", { credentials: "same-origin", cache: "no-store" });
      if (response.status === 401) { setSession(null); return; }
      if (!response.ok) throw new Error("unavailable");
      setSession(await response.json() as Session);
    } catch { setError("The portal session service is unavailable."); setSession(null); }
  };
  useEffect(() => { void refresh(); }, []);
  return { session, error, refresh, clear: () => setSession(null) };
}

function SignIn({ returnTo, onSignedIn }: { returnTo: "/" | "/signed-in"; onSignedIn: () => void }) {
  const [error, setError] = useState("");
  const failed = new URLSearchParams(window.location.search).get("signin") === "failed";
  const login = async (account: string) => {
    setError("");
    const response = await fetch("/__demo/login", { method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account }) }).catch(() => null);
    if (!response?.ok) { setError("Synthetic demo login unavailable; start the local demo API."); return; }
    onSignedIn();
  };
  return <main className={styles.signIn}>
    <div className={styles.signInArt}><Press mode="idle" label="The portal's stamp press, idle" /></div>
    <Card className={styles.signInCard}>
      <h1 className={styles.pageTitle}>Portal sign-in</h1>
      <p className={styles.meta}>The portal checks your institutional account so it can stamp one credential per poll, and lets organisers manage
        their polls. Answers are never submitted here: they go to the separate response site, which needs no sign-in.</p>
      {failed && <p role="alert" className={styles.error}>Sign-in failed. Use your IITGN Google account and try again.</p>}
      {SYNTHETIC ? <>
        <WarningPlate>Local synthetic demo: these buttons sign in invented accounts. They do not authenticate real IITGN accounts and are absent from production builds.</WarningPlate>
        <div className={styles.actions}>
          <Button variant="primary" onClick={() => void login("organiser")}>Sign in as organiser</Button>
          <Button onClick={() => void login("student1")}>Sign in as synthetic participant</Button>
        </div>
      </> : <a className={buttonClass("primary")} href={`/api/v1/auth/login?returnTo=${encodeURIComponent(returnTo)}`}>Sign in with your IITGN Google account</a>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
    </Card>
  </main>;
}

function SignedIn({ session }: { session: Session }) {
  return <main className={styles.signIn}><Card className={styles.signInCard}>
    <h1 className={styles.pageTitle}>You're signed in</h1>
    <p>Signed in as <strong>{session.user.email}</strong>.</p>
    <p className={styles.meta}>Return to the poll's tab on the response site and choose “Open claim window”. This portal tab is not needed for answering.</p>
  </Card></main>;
}

function App() {
  const path = window.location.pathname;
  const { session, error, refresh, clear } = useSession();
  if (path === "/claim-bridge") return <ClaimBridge />;
  const header = <SiteHeader site="Organiser portal" aboutHref="/about" aboutActive={path === "/about"}>
    {session && <IdentityChip email={session.user.email} />}</SiteHeader>;
  if (path === "/about") return <>{header}<About /></>;
  if (path !== "/" && path !== "/signed-in") return <>{header}<NotFound /></>;
  if (session === undefined) return <>{header}<main className={styles.workspace}><p className={styles.meta}>Checking portal session…</p></main></>;
  if (!session) return <>{header}{error && <p role="alert" className={styles.error}>{error}</p>}
    <SignIn returnTo={path === "/signed-in" ? "/signed-in" : "/"} onSignedIn={() => void refresh()} /></>;
  if (path === "/signed-in") return <>{header}<SignedIn session={session} /></>;
  return <>{header}<OrganiserApp session={session} onSignedOut={clear} /></>;
}

createRoot(root).render(<App />);
