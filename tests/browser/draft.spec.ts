// SPEC.md §3 "answers may be drafted before claiming" and §8: prepared/claim_sent/usable
// records carry local draft answers in IndexedDB on the response origin only; acceptance
// erases them. Drafts never go to URLs, Web Storage or any server before submission.
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { respond, stubApis, syntheticPoll } from "./fixtures/claim-stubs";

const ids = { choice: randomUUID(), a: randomUUID(), b: randomUUID(), text: randomUUID() };
const questions = [
  { id: ids.choice, type: "single_choice", prompt: "Which session?", required: true,
    options: [{ id: ids.a, label: "Morning" }, { id: ids.b, label: "Evening" }] },
  { id: ids.text, type: "free_text", prompt: "Anything else?", required: false },
];
const recordOf = (page: Page, pollId: string) => page.evaluate((id) => new Promise<Record<string, unknown> | null>((resolve) => {
  const open = indexedDB.open("iitgn-feedback");
  open.onsuccess = () => {
    if (!open.result.objectStoreNames.contains("credentials")) { open.result.close(); return resolve(null); }
    const get = open.result.transaction("credentials").objectStore("credentials").get(id);
    get.onsuccess = () => { open.result.close(); resolve(get.result ?? null); };
  };
}), pollId);

test("draft answers survive reloads in IndexedDB from preparation to acceptance, then are erased", async ({ page, context }) => {
  const poll = syntheticPoll({ questions });
  const { submissions } = await stubApis(context, poll);
  await page.goto(`${respond}/p/${poll.pollId}`);
  const session = page.getByRole("group", { name: "Which session?" });
  // Drafting is possible before any credential exists.
  await session.getByLabel("Morning").check();
  await page.getByRole("button", { name: "Prepare my credential" }).click();
  await expect(page.getByTestId("credential")).toHaveAttribute("data-state", "prepared");
  await page.getByLabel("Anything else?").fill("Draft text");
  await expect.poll(async () => (await recordOf(page, poll.pollId))?.draft)
    .toEqual({ [ids.choice]: ids.a, [ids.text]: "Draft text" });

  await page.reload();
  await expect(page.getByTestId("credential")).toHaveAttribute("data-state", "prepared");
  await expect(session.getByLabel("Morning")).toBeChecked();
  await expect(page.getByLabel("Anything else?")).toHaveValue("Draft text");

  const [popup] = await Promise.all([page.waitForEvent("popup"), page.getByRole("button", { name: "Open claim window" }).click()]);
  await popup.getByRole("button", { name: "Stamp my envelope" }).click();
  await expect(page.getByTestId("credential")).toHaveAttribute("data-state", "usable");
  expect((await recordOf(page, poll.pollId))?.draft).toEqual({ [ids.choice]: ids.a, [ids.text]: "Draft text" });
  await session.getByLabel("Evening").check();
  await expect.poll(async () => ((await recordOf(page, poll.pollId))?.draft as Record<string, string> | undefined)?.[ids.choice]).toBe(ids.b);
  await page.reload();
  await expect(page.getByTestId("credential")).toHaveAttribute("data-state", "usable");
  await expect(session.getByLabel("Evening")).toBeChecked();
  expect(submissions).toHaveLength(0); // nothing leaves the browser before an explicit submission

  await page.getByRole("button", { name: "Submit answers" }).click();
  await expect(page.getByTestId("credential")).toHaveAttribute("data-state", "accepted");
  expect(Object.keys((await recordOf(page, poll.pollId))!).sort()).toEqual(["closesAt", "pollId", "state"]);
  expect(JSON.parse(submissions[0].raw).answers).toEqual([{ questionId: ids.choice, value: ids.b }, { questionId: ids.text, value: "Draft text" }]);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  expect(page.url()).toBe(`${respond}/p/${poll.pollId}`);
});
