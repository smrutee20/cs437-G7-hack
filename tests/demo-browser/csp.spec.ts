// SPEC.md §14 and §17 scenario 18: the real production bundles run under the strict
// CSP with no violation anywhere in the flow (organiser, response page, claim-bridge
// popup, results), and the policy is demonstrably enforced: inline script, eval,
// inline style attributes and remote loads are all refused.
import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext } from "@playwright/test";

const portal = "https://portal.feedback.test:4173", respond = "https://respond.feedback.test:4174";
const POLICY = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; " +
  "worker-src 'self'; base-uri 'none'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'self'";

/** Every page in the context (popups included) reports CSP violations and errors straight to the test. */
async function watch(context: BrowserContext) {
  const violations: string[] = [], errors: string[] = [];
  await context.exposeBinding("__cspViolation", (_source, text: string) => { violations.push(text); });
  await context.addInitScript(() => document.addEventListener("securitypolicyviolation", (event) =>
    (window as unknown as { __cspViolation: (text: string) => void }).__cspViolation(`${event.violatedDirective} ${event.blockedURI}`)));
  context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
  return { violations, errors };
}

test("the production bundles run the whole flow with zero CSP violations, and the CSP is enforced", async ({ browser }) => {
  test.setTimeout(120_000);
  const account = test.info().project.name.includes("firefox") ? "student39" : "student38";
  const organiserContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const organiserWatch = await watch(organiserContext);
  const organiser = await organiserContext.newPage();
  expect((await organiser.goto(portal))!.headers()["content-security-policy"]).toBe(POLICY);
  expect(await organiser.evaluate(async (name) => (await fetch("/__demo/login", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account: name }) })).status, test.info().project.name.includes("firefox") ? "organiser6" : "organiser5")).toBe(204);
  await organiser.reload();
  await expect(organiser.getByRole("heading", { name: "Your polls" })).toBeVisible();
  const title = `CSP walk ${Date.now()}`;
  const question = { id: randomUUID(), type: "rating", prompt: "How was it?", required: true };
  const pollId = await organiser.evaluate(async ({ q, title }) => {
    const { csrfToken } = await (await fetch("/api/v1/session")).json();
    const headers = { "Content-Type": "application/json", "X-CSRF-Token": csrfToken };
    const created = await (await fetch("/api/v1/polls", { method: "POST", headers, body: JSON.stringify({ title, description: "",
      closesAt: new Date(Date.now() + 86_400_000).toISOString(), questions: [q],
      eligibilityEmails: Array.from({ length: 40 }, (_, i) => `demo-student${i + 1}@iitgn.ac.in`) }) })).json();
    await fetch(`/api/v1/polls/${created.id}/open`, { method: "POST", headers, body: JSON.stringify({ revision: 1 }) });
    return created.id as string;
  }, { q: question, title });

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const participantWatch = await watch(context);
  const page = await context.newPage();
  await page.goto(portal);
  expect(await page.evaluate(async (name) => (await fetch("/__demo/login", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account: name }) })).status, account)).toBe(204);
  const pollResponse = await page.goto(`${respond}/p/${pollId}`);
  expect(pollResponse!.headers()["content-security-policy"]).toBe(POLICY);
  expect(pollResponse!.headers()["cross-origin-opener-policy"]).toBe("unsafe-none");
  await page.getByRole("group", { name: "How was it?" }).getByLabel("5").check();
  await page.getByRole("button", { name: "Prepare my credential" }).click();
  const [popup] = await Promise.all([page.waitForEvent("popup"), page.getByRole("button", { name: "Open claim window" }).click()]);
  await popup.getByRole("button", { name: "Stamp my envelope" }).click();
  await expect(page.getByTestId("credential")).toHaveAttribute("data-state", "usable");
  await page.getByRole("button", { name: "Submit answers" }).click();
  await expect(page.getByTestId("credential")).toHaveAttribute("data-state", "accepted");
  await page.goto(`${respond}/not-a-page`);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();

  await organiser.reload();
  const item = organiser.getByRole("listitem").filter({ hasText: title });
  await item.getByRole("button", { name: "Close poll" }).click();
  await organiser.getByRole("dialog").getByLabel("Type CLOSE to confirm").fill("CLOSE");
  await organiser.getByRole("dialog").getByRole("button", { name: "Close poll now" }).click();
  await expect(organiser.getByRole("status")).toHaveText("Poll is closed.");
  await organiser.getByRole("listitem").filter({ hasText: title }).getByRole("button", { name: "View results" }).click();
  await expect(organiser.getByRole("region", { name: "Results" })).toContainText("1 response");

  expect(organiserWatch.violations).toEqual([]);
  expect(participantWatch.violations).toEqual([]);
  expect([...organiserWatch.errors, ...participantWatch.errors]).toEqual([]);

  // Positive controls on a real production page: the policy is enforced, not merely sent.
  const requests: string[] = [];
  // Chromium announces a request before CSP blocks it; what matters is that none ever completes.
  page.on("requestfinished", (request) => requests.push(request.url()));
  page.on("response", (response) => requests.push(response.url()));
  await page.goto(`${respond}/p/${pollId}`);
  await expect(page.getByTestId("credential")).toHaveAttribute("data-state", "accepted");
  const probes = await page.evaluate(async () => {
    const script = document.createElement("script");
    script.textContent = "window.__inline = 1";
    document.head.append(script);
    // String timers are eval: blocked without 'unsafe-eval' (this runs as ordinary page code).
    (window.setTimeout as unknown as (code: string, ms: number) => number)("window.__timer = 1", 0);
    const styled = document.createElement("div");
    document.body.append(styled);
    styled.setAttribute("style", "color: rgb(1, 2, 3)");
    const image = new Image();
    image.src = "https://evil.example/pixel.png";
    await new Promise((done) => setTimeout(done, 300));
    const w = window as unknown as { __inline?: number; __timer?: number };
    return { inline: w.__inline ?? null, timer: w.__timer ?? null, color: getComputedStyle(styled).color };
  });
  expect(probes).toEqual({ inline: null, timer: null, color: expect.not.stringMatching(/rgb\(1, 2, 3\)/) });
  expect(requests.filter((url) => url.includes("evil.example"))).toEqual([]);
  expect(participantWatch.violations.map((entry) => entry.split(" ")[0]).sort())
    .toEqual(expect.arrayContaining(["img-src", "script-src-elem", "style-src-attr"]));
});
