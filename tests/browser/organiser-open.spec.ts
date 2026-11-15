// Issue #5: before opening, warn when the saved eligibility list mixes
// roll-number and name addresses, because eligibility is an exact match.
import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext } from "@playwright/test";
import { CSRF, portal } from "./fixtures/claim-stubs";

const json = (status: number, body: unknown) =>
  ({ status, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify(body) });

async function stubOrganiser(context: BrowserContext, eligibilityEmails: string[]) {
  const id = randomUUID();
  const summary = { id, title: "Synthetic course feedback", status: "draft", invalidated: false, revision: 1,
    closesAt: new Date(Date.now() + 86_400_000).toISOString(), closedAt: null, eligibilityRetention: "retained",
    policy: { version: 2, minEligible: 1, minResponses: 1, minAnswersPerQuestion: 1 } };
  const owned = { ...summary, description: "", createdAt: new Date().toISOString(), openedAt: null,
    questions: [{ id: randomUUID(), type: "rating", prompt: "How was it?", required: true }],
    eligibleCount: eligibilityEmails.length, eligibilityEmails };
  const posts: string[] = [];
  await context.route(`${portal}/api/v1/session`, (route) =>
    route.fulfill(json(200, { user: { id: randomUUID(), email: "organiser@iitgn.ac.in", isOrganiser: true }, csrfToken: CSRF })));
  await context.route((url) => url.origin === portal && url.pathname.startsWith("/api/v1/polls"), (route) => {
    const request = route.request();
    if (request.method() !== "GET") { posts.push(request.url()); return route.fulfill(json(500, {})); }
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/polls") return route.fulfill(json(200, { items: [summary] }));
    if (path === `/api/v1/polls/${id}`) return route.fulfill(json(200, owned));
    return route.fulfill(json(404, { error: { code: "not_found", message: "not found" } }));
  });
  return { posts };
}

async function openConfirmation(page: import("@playwright/test").Page) {
  await page.goto(`${portal}/`);
  const item = page.getByRole("list", { name: "Owned polls" }).getByRole("listitem").filter({ hasText: "Synthetic course feedback" });
  await item.getByRole("button", { name: "Open poll" }).click();
  const dialog = page.getByRole("dialog", { name: /Open “Synthetic course feedback”/ });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("a list mixing roll-number and name addresses warns in the open confirmation", async ({ page, context }) => {
  const { posts } = await stubOrganiser(context, ["22110123@iitgn.ac.in", "22110124@iitgn.ac.in", "jane.doe@iitgn.ac.in"]);
  const dialog = await openConfirmation(page);
  const warning = dialog.getByTestId("mixed-address-warning");
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("2 roll-number addresses");
  await expect(warning).toContainText("1 name address");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(posts).toEqual([]);
});

test("a uniform list shows no mixed-address warning", async ({ page, context }) => {
  await stubOrganiser(context, ["22110123@iitgn.ac.in", "22110124@iitgn.ac.in", "22110125@iitgn.ac.in"]);
  const dialog = await openConfirmation(page);
  await expect(dialog.getByText("Opening is irreversible.")).toBeVisible();
  await expect(dialog.getByTestId("mixed-address-warning")).toHaveCount(0);
});
