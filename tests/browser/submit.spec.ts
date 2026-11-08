// SPEC.md §8 cleanup/confirmation and §10 retries, in real browsers on the
// response origin, with the submission API stubbed and credentials verified in Node.
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { claimCredential, respond, stubApis, syntheticPoll, type SyntheticPoll } from "./fixtures/claim-stubs";

const ids = { choice: randomUUID(), a: randomUUID(), b: randomUUID(), rating: randomUUID(), text: randomUUID() };
const questions = [
  { id: ids.choice, type: "single_choice", prompt: "Which session?", required: true,
    options: [{ id: ids.a, label: "Morning" }, { id: ids.b, label: "Evening" }] },
  { id: ids.rating, type: "rating", prompt: "How useful was it?", required: false },
  { id: ids.text, type: "free_text", prompt: "Anything else?", required: false },
];
const poll = () => syntheticPoll({ questions });
const recordOf = (page: Page, pollId: string) => page.evaluate((id) => new Promise<Record<string, unknown> | null>((resolve) => {
  const open = indexedDB.open("iitgn-feedback");
  open.onsuccess = () => {
    const get = open.result.transaction("credentials").objectStore("credentials").get(id);
    get.onsuccess = () => { open.result.close(); resolve(get.result ? { ...get.result, keys: Object.keys(get.result).sort() } : null); };
  };
}), pollId);
async function answer(page: Page, text = "  Clear examples \r\n") {
  await page.getByRole("group", { name: "Which session?" }).getByLabel("Evening").check();
  await page.getByRole("group", { name: "How useful was it?" }).getByLabel("4").check();
  await page.getByLabel("Anything else?").fill(text);
}
const credentialState = (page: Page) => page.getByTestId("credential");
const accepted = { status: 201, body: { status: "accepted" } };

test("answers are sent once, canonical and cookie-free; success erases the credential and keeps only a marker", async ({ page, context }) => {
  const p = poll();
  const { submissions } = await stubApis(context, p);
  await claimCredential(page, p);
  await answer(page);
  await page.getByRole("button", { name: "Submit answers" }).click();
  await expect(credentialState(page)).toHaveAttribute("data-state", "accepted");
  await expect(page.getByTestId("submit-message")).toContainText("Your response was recorded");
  expect(submissions).toHaveLength(1);
  const sent = JSON.parse(submissions[0].raw);
  expect(submissions[0].validCredential).toBe(true);
  expect(Object.keys(sent).sort()).toEqual(["answers", "credential"]);
  expect(Object.keys(sent.credential).sort()).toEqual(["keyId", "keyVersion", "preparedMessage", "signature", "version"]);
  expect(sent.answers).toEqual([
    { questionId: ids.choice, value: ids.b }, { questionId: ids.rating, value: 4 }, { questionId: ids.text, value: "Clear examples" },
  ]);
  expect(new URL(submissions[0].url).search).toBe("");
  expect(submissions[0].headers.cookie).toBeUndefined();
  expect((await recordOf(page, p.pollId))!.keys).toEqual(["closesAt", "pollId", "state"]);
  await page.reload();
  await expect(credentialState(page)).toHaveAttribute("data-state", "accepted");
  await expect(page.getByRole("button", { name: "Submit answers" })).toHaveCount(0);
});

test("a missing required answer is explained before sending; a server 422 returns to editing without spending", async ({ page, context }) => {
  const p = poll();
  const { submissions } = await stubApis(context, p, {
    respond: (_call, index) => index === 0
      ? { status: 422, body: { error: { code: "validation_failed", message: "validation failed", field: "answers[1].value" } } }
      : accepted,
  });
  await claimCredential(page, p);
  await page.getByLabel("Anything else?").fill("Only text");
  await page.getByRole("button", { name: "Submit answers" }).click();
  await expect(page.getByTestId("submit-message")).toContainText("Answer every required question");
  expect(submissions).toHaveLength(0);
  await answer(page);
  await page.getByRole("button", { name: "Submit answers" }).click();
  await expect(page.getByTestId("submit-message")).toContainText("rejected these answers");
  await expect(credentialState(page)).toHaveAttribute("data-state", "usable");
  await page.getByRole("button", { name: "Submit answers" }).click();
  await expect(credentialState(page)).toHaveAttribute("data-state", "accepted");
  expect(submissions).toHaveLength(2);
});

test("after an uncertain attempt the exact payload is kept, answers freeze, and only an explicit retry resends it", async ({ page, context }) => {
  const p = poll();
  const outcomes = [null, { status: 429, body: { error: { code: "rate_limited", message: "rate limited" } } }, { status: 200, body: { status: "accepted" } }];
  const { submissions } = await stubApis(context, p, { respond: (_call, index) => (index < outcomes.length ? outcomes[index] : accepted) });
  await claimCredential(page, p);
  await answer(page);
  await page.getByRole("button", { name: "Submit answers" }).click();
  await expect(page.getByTestId("submit-message")).toContainText("could not be confirmed");
  await expect(credentialState(page)).toHaveAttribute("data-state", "submit_pending");
  await expect(page.getByRole("button", { name: "Submit answers" })).toHaveCount(0);
  await expect(page.getByLabel("Anything else?")).toHaveCount(0); // frozen: shown read-only, not editable
  expect(submissions).toHaveLength(1); // no automatic retry
  await page.reload();
  await expect(credentialState(page)).toHaveAttribute("data-state", "submit_pending");
  await page.getByRole("button", { name: "Retry submission" }).click();
  await expect(page.getByTestId("submit-message")).toContainText("Too many submissions");
  // A rate limit after an uncertain attempt does not prove that attempt failed.
  await expect(credentialState(page)).toHaveAttribute("data-state", "submit_pending");
  await page.getByRole("button", { name: "Retry submission" }).click();
  await expect(credentialState(page)).toHaveAttribute("data-state", "accepted");
  expect(submissions).toHaveLength(3);
  expect(new Set(submissions.map((call) => call.raw)).size).toBe(1); // byte-identical payloads
});

test("a credential spent with different answers is erased without claiming those answers were recorded", async ({ page, context }) => {
  const p = poll();
  await stubApis(context, p, { respond: () => ({ status: 409, body: { error: { code: "credential_spent", message: "credential spent" } } }) });
  await claimCredential(page, p);
  await answer(page);
  await page.getByRole("button", { name: "Submit answers" }).click();
  await expect(credentialState(page)).toHaveAttribute("data-state", "spent");
  await expect(page.getByTestId("submit-message")).toContainText("were not recorded");
  expect((await recordOf(page, p.pollId))!.keys).toEqual(["closesAt", "pollId", "state"]);
});

test("closure erases an unused credential and ends a first submission, but a pending one is kept to confirm", async ({ browser }) => {
  // (a) Unused credential, then the poll is observed closed.
  const unused = poll();
  const first = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await first.newPage();
  await stubApis(first, unused);
  await claimCredential(page, unused);
  unused.dto.status = "closed";
  await page.reload();
  await expect(credentialState(page)).toHaveAttribute("data-state", "none");
  expect(await recordOf(page, unused.pollId)).toBeNull();
  await first.close();

  // (b) A first submission refused as closed: secret state is erased.
  const late = poll();
  const second = await browser.newContext({ ignoreHTTPSErrors: true });
  const latePage = await second.newPage();
  await stubApis(second, late, { respond: () => ({ status: 410, body: { error: { code: "poll_closed", message: "poll closed" } } }) });
  await claimCredential(latePage, late);
  await answer(latePage);
  await latePage.getByRole("button", { name: "Submit answers" }).click();
  await expect(latePage.getByTestId("submit-message")).toContainText("closed");
  expect(await recordOf(latePage, late.pollId)).toBeNull();
  await second.close();

  // (c) A pending submission survives observed closure, can still be confirmed, and expires 24 h after the deadline.
  const pending = poll();
  const third = await browser.newContext({ ignoreHTTPSErrors: true });
  const pendingPage = await third.newPage();
  await pendingPage.clock.install();
  await stubApis(third, pending, { respond: () => null });
  await claimCredential(pendingPage, pending);
  await answer(pendingPage);
  await pendingPage.getByRole("button", { name: "Submit answers" }).click();
  await expect(credentialState(pendingPage)).toHaveAttribute("data-state", "submit_pending");
  pending.dto.status = "closed";
  await pendingPage.reload();
  await expect(credentialState(pendingPage)).toHaveAttribute("data-state", "submit_pending");
  await pendingPage.clock.fastForward("49:00:00"); // past closesAt (+24 h) plus the 24 h confirmation window
  await expect(credentialState(pendingPage)).toHaveAttribute("data-state", "none");
  expect(await recordOf(pendingPage, pending.pollId)).toBeNull();
  await third.close();
});

test("the response origin keeps working with no portal session and sends no credentials to the API", async ({ page, context }) => {
  const p = poll();
  const { submissions } = await stubApis(context, p);
  await claimCredential(page, p);
  await context.addCookies([{ name: "probe", value: "respond-cookie", url: respond, secure: true, sameSite: "Lax" }]);
  await answer(page);
  await page.getByRole("button", { name: "Submit answers" }).click();
  await expect(credentialState(page)).toHaveAttribute("data-state", "accepted");
  expect(submissions[0].headers.cookie).toBeUndefined(); // fetch uses credentials: "omit"
});

test("public status is refreshed before a new submission: a poll closed meanwhile erases the credential and sends nothing", async ({ page, context }) => {
  const p = poll();
  const { submissions } = await stubApis(context, p);
  await claimCredential(page, p);
  await answer(page);
  p.dto.status = "closed"; // closed after this page loaded; no reload
  await page.getByRole("button", { name: "Submit answers" }).click();
  await expect(page.getByTestId("submit-message")).toContainText("closed");
  await expect(credentialState(page)).toHaveAttribute("data-state", "none");
  expect(await recordOf(page, p.pollId)).toBeNull();
  expect(submissions).toHaveLength(0);
});
