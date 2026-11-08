// Synthetic end-to-end claim: real portal API, feedback_issuer DB role, pinned
// workerd native signer, both HTTPS origins. Invented accounts only.
import { createPublicKey, randomUUID } from "node:crypto";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { Client } from "pg";
import { nodeVerifyPss } from "../fixtures/rsa";

const portal = "https://portal.feedback.test:4173";
const respond = "https://respond.feedback.test:4174";
// The demo's disposable local database (same fixed loopback URL as the launcher).
const localDb = "postgres://feedback_local_admin:feedback_local_only_not_for_production@127.0.0.1:55432/feedback_local";

async function signedIn(browser: Browser, account: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await page.goto(portal);
  const status = await page.evaluate(async (name) => (await fetch("/__demo/login", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account: name }) })).status, account);
  expect(status).toBe(204);
  return { context, page };
}

async function openedPoll(browser: Browser) {
  const { context, page } = await signedIn(browser, "organiser");
  try {
    return await page.evaluate(async (draft) => {
      const { csrfToken } = await (await fetch("/api/v1/session")).json();
      const headers = { "Content-Type": "application/json", "X-CSRF-Token": csrfToken };
      const created = await (await fetch("/api/v1/polls", { method: "POST", headers, body: JSON.stringify(draft) })).json();
      const opened = await fetch(`/api/v1/polls/${created.id}/open`, { method: "POST", headers, body: JSON.stringify({ revision: 1 }) });
      if (!opened.ok) throw new Error(`open failed ${opened.status}`);
      return (await (await fetch(`/api/v1/polls/${created.id}/claim-context`)).json()) as
        { id: string; title: string; questions: { id: string }[]; key: { publicJwk: { kty: "RSA"; n: string; e: "AQAB" } } };
    }, {
      title: `Synthetic claim ${Date.now()}`, description: "", closesAt: new Date(Date.now() + 86_400_000).toISOString(),
      questions: [{ id: randomUUID(), type: "rating", prompt: "How was it?", required: true }],
      eligibilityEmails: Array.from({ length: 40 }, (_, i) => `demo-student${i + 1}@iitgn.ac.in`),
    });
  } finally { await context.close(); }
}

async function claim(page: Page, pollId: string) {
  await page.goto(`${respond}/p/${pollId}`);
  await page.getByRole("button", { name: "Prepare credential" }).click();
  await expect(page.getByTestId("credential")).toHaveAttribute("data-state", "prepared");
  const [bridge] = await Promise.all([page.waitForEvent("popup"), page.getByRole("button", { name: "Open claim window" }).click()]);
  await expect(bridge.getByTestId("bridge")).toHaveAttribute("data-state", "confirming");
  await bridge.getByRole("button", { name: "Claim credential" }).click();
  return bridge;
}

const storedCredential = (page: Page, pollId: string) => page.evaluate((id) => new Promise<Record<string, string>>((resolve) => {
  const open = indexedDB.open("iitgn-feedback");
  open.onsuccess = () => {
    const get = open.result.transaction("credentials").objectStore("credentials").get(id);
    get.onsuccess = () => {
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(get.result)) {
        out[key] = value instanceof Uint8Array ? btoa(String.fromCharCode(...value)) : String(value);
      }
      open.result.close();
      resolve(out);
    };
  };
}), pollId);

test("an eligible synthetic participant claims a natively signed credential and submits one anonymous response; the same account cannot claim again", async ({ browser }) => {
  const poll = await openedPoll(browser);
  // Per-project accounts: projects run in parallel against one launcher's per-account claim limit.
  const participant = test.info().project.name.includes("firefox") ? "student21" : "student1";
  const first = await signedIn(browser, participant);
  try {
    await claim(first.page, poll.id);
    await expect(first.page.getByTestId("credential")).toHaveAttribute("data-state", "usable");
    const record = await storedCredential(first.page, poll.id);
    expect(record.inverse).toBeUndefined();
    const key = createPublicKey({ key: poll.key.publicJwk, format: "jwk" });
    expect(nodeVerifyPss(key, Buffer.from(record.prepared, "base64"), Buffer.from(record.signature, "base64"))).toBe(true);
    // The response origin never received the portal session cookie.
    expect((await first.context.cookies(respond)).map((cookie) => cookie.name)).not.toContain("__Host-session");

    // Answer and submit through the real response API: exactly one anonymous row results.
    await first.page.getByRole("group", { name: /How was it\?/ }).getByLabel("4").check();
    await first.page.getByRole("button", { name: "Submit answers" }).click();
    await expect(first.page.getByTestId("credential")).toHaveAttribute("data-state", "accepted");
    expect(Object.keys(await storedCredential(first.page, poll.id)).sort()).toEqual(["closesAt", "pollId", "state"]);
    const db = new Client({ connectionString: localDb });
    await db.connect();
    try {
      const { rows } = await db.query("SELECT * FROM anonymous.responses WHERE poll_id=$1", [poll.id]);
      expect(rows).toHaveLength(1);
      expect(Object.keys(rows[0]).sort()).toEqual(["answers", "nullifier", "poll_id"]);
      expect(rows[0].answers).toEqual([{ questionId: poll.questions[0].id, value: 4 }]);
    } finally { await db.end(); }
  } finally { await first.context.close(); }

  // Same account, fresh browser storage: the server-side entitlement is already consumed.
  const again = await signedIn(browser, participant);
  try {
    await claim(again.page, poll.id);
    await expect(again.page.getByTestId("credential")).toHaveAttribute("data-state", "claim_consumed");
  } finally { await again.context.close(); }

  const outsider = await signedIn(browser, "ineligible");
  try {
    await claim(outsider.page, poll.id);
    await expect(outsider.page.getByTestId("claim-message")).toContainText("not on this poll's eligibility list");
    await expect(outsider.page.getByTestId("credential")).toHaveAttribute("data-state", "prepared");
  } finally { await outsider.context.close(); }
});
