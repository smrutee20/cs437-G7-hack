import { expect, test } from "@playwright/test";
import { localOrigins } from "../../packages/config/src/local-dev.js";
import { SPIKE_POLL } from "../../apps/respond/src/spike-poll";

// Runs only in the *-popup-blocker projects, where Playwright's default popup-blocker
// bypass is removed (Chromium) or the blocker pref is re-enabled (Firefox).
const respond = localOrigins().respond.origin;
const pollPage = `${respond}/p/${SPIKE_POLL.pollId}`;

test("the browser blocks a popup without a user gesture but allows the click-initiated claim window", async ({ page, context }) => {
  // Control: a page script opening a window during load has no user activation.
  // (page.evaluate is not used to open: Playwright evaluates with a simulated gesture.)
  await context.route(`${respond}/popup-control`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><script>window.__blocked = window.open("about:blank") === null;</script>',
    }),
  );
  await page.goto(`${respond}/popup-control`);
  expect(await page.evaluate(() => (window as unknown as { __blocked: boolean }).__blocked)).toBe(true);

  await page.goto(pollPage);
  await expect(page.getByTestId("capabilities")).toHaveAttribute("data-state", "supported");
  const [popup] = await Promise.all([page.waitForEvent("popup"), page.getByRole("button", { name: "Open claim window" }).click()]);
  await expect(popup.getByTestId("bridge")).toHaveAttribute("data-state", "connected");
  await expect(page.getByTestId("claim-window")).toHaveAttribute("data-state", "connected");
});
