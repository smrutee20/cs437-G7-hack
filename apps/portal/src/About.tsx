import { buttonClass } from "@iitgn-feedback/ui";
import styles from "./Portal.module.css";

/** Public explanation of the design, without implying stronger anonymity than the protocol provides. */
export function About() {
  return <main className={styles.about}>
    <div className={styles.aboutIntro}>
      <h1 className={styles.pageTitle}>Why Freed Back?</h1>
      <p className={styles.aboutLead}>The internet has a habit of attaching a name tag and a trail of breadcrumbs to everything we say. Even ordinary opinions feel different when they can be tracked, collected, and pulled out of context later. We think people should have room to speak without that machinery always looking over their shoulder.</p>
      <p>That’s the idea behind Freed Back: feedback with a little freedom built in, and something useful given back. The portal checks whether an institutional account may respond. A separate response site accepts answers without asking anyone to sign in. The two jobs are designed to stay apart.</p>
      <p>Here’s the clever bit: blind-signature cryptography gives your browser a mathematical envelope. The portal checks your account and stamps a blinded credential without seeing the credential itself. Back on the response site, your browser opens the envelope and submits with the credential instead of your login. A little mathematical choreography to keep “who may answer?” and “what did they say?” in different rooms.</p>
      <section className={styles.aboutCard} aria-labelledby="about-status">
        <h2 id="about-status">Where it stands today</h2>
        <p>Freed Back is deployed on AWS as a proof of concept. This setup is built to demonstrate the idea, not to collect real feedback yet. The design is intended to support real use with additional production configuration.</p>
      </section>
    </div>
    <div className={styles.aboutGrid}>
      <section className={styles.aboutCard} aria-labelledby="about-eligibility">
        <h2 id="about-eligibility">One invitation, one credential</h2>
        <p>An organiser invites institutional email addresses to a poll. You sign in at the portal to show that you are eligible; it stamps a sealed credential without seeing the credential inside. Your answers go to the separate response site, which does not ask you to sign in.</p>
      </section>
      <section className={styles.aboutCard} aria-labelledby="about-results">
        <h2 id="about-results">Patterns, not live tracking</h2>
        <p>Organisers see no live response count or individual response feed. Results appear only when the poll closes and at least five responses were received. Each question needs five answers to be shown; otherwise its results are withheld.</p>
      </section>
      <section className={styles.aboutCard} aria-labelledby="about-control">
        <h2 id="about-control">Your browser holds the key</h2>
        <p>The credential stays in the browser where you prepared it and can be used once. Clearing that browser’s site data or switching devices can lose it; a spent or lost claim cannot be replaced for the poll. Keep the response tab open while signing in to the portal.</p>
      </section>
    </div>
    <a className={`${buttonClass("secondary")} ${styles.aboutBack}`} href="/">Return to the portal</a>
  </main>;
}
