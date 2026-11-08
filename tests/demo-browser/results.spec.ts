// Synthetic walkthrough (SPEC.md §17, scenario 27): ten eligible accounts, five
// anonymous responses → ready results; four responses → permanently withheld.
// Hostile free text must render as inert text in the organiser's view.
import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";

const portal = "https://portal.feedback.test:4173";
const respond = "https://respond.feedback.test:4174";
const HOSTILE = ['<img src="https://evil.example/x.png" onerror="window.__xss=1">', "<script>window.__xss=2</script>", "**bold** https://evil.example/link"];

async function signedIn(browser: Browser, account: string): Promise<Page> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await page.goto(portal);
  expect(await page.evaluate(async (name) => (await fetch("/__demo/login", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account: name }) })).status, account)).toBe(204);
  return page;
}
async function openPoll(organiser: Page, title: string, questions: unknown[]) {
  return organiser.evaluate(async ({ title, questions }) => {
    const { csrfToken } = await (await fetch("/api/v1/session")).json();
    const headers = { "Content-Type": "application/json", "X-CSRF-Token": csrfToken };
    const created = await (await fetch("/api/v1/polls", { method: "POST", headers, body: JSON.stringify({
      title, description: "", closesAt: new Date(Date.now() + 86_400_000).toISOString(), questions,
      eligibilityEmails: Array.from({ length: 40 }, (_, i) => `demo-student${i + 1}@iitgn.ac.in`) }) })).json();
    await fetch(`/api/v1/polls/${created.id}/open`, { method: "POST", headers, body: JSON.stringify({ revision: 1 }) });
    return created.id as string;
  }, { title, questions });
}
async function participate(browser: Browser, account: string, pollId: string, answer: (page: Page) => Promise<void>) {
  const page = await signedIn(browser, account);
  await page.goto(`${respond}/p/${pollId}`);
  await page.getByRole("button", { name: "Prepare credential" }).click();
  const [bridge] = await Promise.all([page.waitForEvent("popup"), page.getByRole("button", { name: "Open claim window" }).click()]);
  await bridge.getByRole("button", { name: "Claim credential" }).click();
  await expect(page.getByTestId("credential")).toHaveAttribute("data-state", "usable");
  await answer(page);
  await page.getByRole("button", { name: "Submit answers" }).click();
  await expect(page.getByTestId("credential")).toHaveAttribute("data-state", "accepted");
  await page.context().close();
}
async function closeAndView(organiser: Page, title: string) {
  await organiser.goto(portal);
  const item = organiser.getByRole("listitem").filter({ hasText: title });
  const dialog = organiser.waitForEvent("dialog").then((d) => d.accept());
  await item.getByRole("button", { name: "Close poll" }).click();
  await dialog;
  await expect(organiser.getByRole("status")).toHaveText("Poll is closed.");
  await organiser.getByRole("listitem").filter({ hasText: title }).getByRole("button", { name: "View results" }).click();
  return organiser.getByRole("region", { name: "Results" });
}

test("five synthetic responses publish inert aggregate results; four are permanently withheld", async ({ browser }) => {
  test.setTimeout(120_000);
  // Per-project account ranges: projects run in parallel against one launcher and its per-account claim limit.
  const base = test.info().project.name.includes("firefox") ? 20 : 0;
  const organiser = await signedIn(browser, "organiser");
  const choice = { id: randomUUID(), type: "single_choice", prompt: "Which session?", required: true,
    options: [{ id: randomUUID(), label: "Morning" }, { id: randomUUID(), label: "Evening" }] };
  const text = { id: randomUUID(), type: "free_text", prompt: "Anything else?", required: false };
  const title = `Walkthrough ${Date.now()}`;
  const pollId = await openPoll(organiser, title, [choice, text]);
  const requests: string[] = [];
  organiser.context().on("request", (request) => requests.push(request.url()));
  for (let i = 0; i < 5; i++) {
    await participate(browser, `student${base + i + 2}`, pollId, async (page) => {
      await page.getByRole("group", { name: /Which session\?/ }).getByLabel(i < 3 ? "Morning" : "Evening").check();
      if (i < HOSTILE.length) await page.getByLabel("Anything else?").fill(HOSTILE[i]);
    });
  }
  const results = await closeAndView(organiser, title);
  await expect(results).toContainText("5 responses");
  await expect(results).toContainText("Morning: 3 (60%)");
  await expect(results).toContainText("Evening: 2 (40%)");
  // Three texts is below the five-answer question threshold: withheld, with no texts shown.
  await expect(results).toContainText("Withheld: fewer than five answers");
  await expect(results).not.toContainText("evil.example");
  expect(await organiser.evaluate(() => (window as { __xss?: number }).__xss)).toBeUndefined();

  // A second poll where five people answer the free text: hostile strings are shown literally.
  const textTitle = `Walkthrough text ${Date.now()}`;
  const textPoll = await openPoll(organiser, textTitle, [choice, text]);
  for (let i = 0; i < 5; i++) {
    await participate(browser, `student${base + i + 2}`, textPoll, async (page) => {
      await page.getByRole("group", { name: /Which session\?/ }).getByLabel("Morning").check();
      await page.getByLabel("Anything else?").fill(HOSTILE[i] ?? `Plain remark ${i}`);
    });
  }
  const textResults = await closeAndView(organiser, textTitle);
  for (const hostile of HOSTILE) await expect(textResults.getByText(hostile, { exact: true })).toBeVisible();
  await expect(textResults.locator("img, script, a")).toHaveCount(0);
  expect(await organiser.evaluate(() => (window as { __xss?: number }).__xss)).toBeUndefined();
  expect(requests.filter((url) => url.includes("evil.example"))).toEqual([]);

  // Four responses: permanently withheld, with no count disclosed.
  const smallTitle = `Walkthrough small ${Date.now()}`;
  const smallPoll = await openPoll(organiser, smallTitle, [choice]);
  for (let i = 0; i < 4; i++) {
    await participate(browser, `student${base + i + 7}`, smallPoll, async (page) => {
      await page.getByRole("group", { name: /Which session\?/ }).getByLabel("Morning").check();
    });
  }
  const small = await closeAndView(organiser, smallTitle);
  await expect(small.getByText(/permanently withheld/)).toHaveText(
    "Results are permanently withheld: fewer than five responses were received.");
  // No numeric count of any kind: neither a "N responses" line nor "N answered".
  await expect(small).not.toContainText(/\b\d+ (responses|answered)\b/);
});
