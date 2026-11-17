// Issue #4: a poll with few eligible people or a low response minimum warns,
// specifically and before any credential is prepared or claimed.
import { expect, test, type Page } from "@playwright/test";
import { respond, stubApis, syntheticPoll } from "./fixtures/claim-stubs";

const V1 = { version: 1, minEligible: 10, minResponses: 5, minAnswersPerQuestion: 5 };

async function load(page: Page, pollId: string) {
  await page.goto(`${respond}/p/${pollId}`);
  await expect(page.getByTestId("capabilities")).toHaveAttribute("data-state", "supported");
  await expect(page.getByRole("button", { name: "Prepare my credential" })).toBeVisible();
}

test("a below-threshold poll shows a specific warning before Prepare my credential", async ({ page, context }) => {
  const poll = syntheticPoll({ eligibleCount: 3 });
  await stubApis(context, poll);
  await load(page, poll.pollId);
  const warning = page.getByTestId("small-poll-warning");
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("Only 3 people can respond to this poll.");
  await expect(warning).toContainText("as few as 1 response.");
  const prepare = page.getByRole("button", { name: "Prepare my credential" });
  // The warning precedes the button in reading order, so it is seen before the claim starts.
  expect(await warning.evaluate((node, button) => Boolean(node.compareDocumentPosition(button!) & Node.DOCUMENT_POSITION_FOLLOWING),
    await prepare.elementHandle())).toBe(true);
  await prepare.click();
  await expect(page.getByTestId("credential")).toHaveAttribute("data-state", "prepared");
  await expect(warning).toBeVisible(); // still shown before the claim window is opened
});

test("a v2 poll with enough eligible people still warns about its response minimum", async ({ page, context }) => {
  const poll = syntheticPoll({ eligibleCount: 40 });
  await stubApis(context, poll);
  await load(page, poll.pollId);
  await expect(page.getByTestId("small-poll-warning")).toContainText("as few as 1 response.");
  await expect(page.getByTestId("small-poll-warning")).not.toContainText("can respond to this poll");
});

test("a poll at or above the threshold shows no small-poll warning", async ({ page, context }) => {
  const poll = syntheticPoll({ eligibleCount: 10, policy: V1 });
  await stubApis(context, poll);
  await load(page, poll.pollId);
  await expect(page.getByTestId("small-poll-warning")).toHaveCount(0);
});
