// SPEC.md §8 interruptions: a window closed mid-claim, and a session that ends
// between the bridge loading and the claim POST.
import { expect, test, type Page } from "@playwright/test";
import { respond, stubApis, syntheticPoll, type SyntheticPoll } from "./fixtures/claim-stubs";

async function prepared(page: Page, poll: SyntheticPoll) {
  await page.goto(`${respond}/p/${poll.pollId}`);
  await page.getByRole("button", { name: "Prepare my credential" }).click();
  await expect(page.getByTestId("credential")).toHaveAttribute("data-state", "prepared");
}
async function openBridge(page: Page) {
  const [popup] = await Promise.all([page.waitForEvent("popup"), page.getByRole("button", { name: "Open claim window" }).click()]);
  return popup;
}

test("closing the claim window after the request was handed over leaves an uncertain claim, never a fresh one", async ({ page, context }) => {
  const poll = syntheticPoll();
  const { calls } = await stubApis(context, poll);
  await prepared(page, poll);
  const popup = await openBridge(page);
  await expect(popup.getByTestId("bridge")).toHaveAttribute("data-state", "confirming");
  await popup.close();
  await expect(page.getByTestId("claim-window")).toHaveAttribute("data-state", "bridge_closed");
  // claim_sent was durable before the bridge had the request, so this browser may not start over.
  await expect(page.getByTestId("credential")).toHaveAttribute("data-state", "claim_sent");
  await expect(page.getByRole("button", { name: /Open claim window|Prepare my credential/ })).toHaveCount(0);
  expect(calls).toHaveLength(0);
});

test("a session that expires before the claim POST returns login_required, and nothing is consumed", async ({ page, context }) => {
  const poll = syntheticPoll();
  const { calls } = await stubApis(context, poll, {
    claim: () => ({ status: 401, body: { error: { code: "authentication_required", message: "authentication required" } } }),
  });
  await prepared(page, poll);
  const popup = await openBridge(page);
  await popup.getByRole("button", { name: "Stamp my envelope" }).click();
  await expect(page.getByTestId("credential")).toHaveAttribute("data-state", "prepared");
  await expect(page.getByTestId("claim-message")).toContainText("Sign in to the portal");
  expect(calls).toHaveLength(1);
});
