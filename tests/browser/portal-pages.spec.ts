import { expect, test } from "@playwright/test";
import { localOrigins } from "../../packages/config/src/local-dev.js";

const { portal, respond } = localOrigins();

test("the public About page opens from the response site without replacing the response tab", async ({ page, context }) => {
  await page.goto(`${respond.origin}/`);
  const fromRespond = page.getByRole("link", { name: "About" });
  await expect(fromRespond).toHaveAttribute("href", `${portal.origin}/about`);
  await expect(fromRespond).toHaveAttribute("target", "_blank");
  await expect(fromRespond).toHaveAttribute("rel", /noopener/);
  const [about] = await Promise.all([context.waitForEvent("page"), fromRespond.click()]);
  await expect(about).toHaveURL(`${portal.origin}/about`);
  await expect(page).toHaveURL(`${respond.origin}/`);
  await expect(about.getByRole("heading", { name: "Why Freed Back?" })).toBeVisible();
  await expect(about.getByText(/deployed on AWS as a proof of concept/i)).toBeVisible();
  await expect(about.getByText(/not to collect real feedback yet/i)).toBeVisible();
  await expect(about.getByText(/five responses/i).first()).toBeVisible();
  await expect(about.getByRole("link", { name: /IITGN Freed Back/ })).toHaveAttribute("href", "/");
});

test("portal form labels fit their controls instead of reserving a tall empty block", async ({ page }) => {
  await page.route(`${portal.origin}/api/v1/session`, (route) => route.fulfill({ json: {
    user: { id: "11111111-1111-4111-8111-111111111111", email: "synthetic@iitgn.ac.in", isOrganiser: true }, csrfToken: "test-csrf",
  } }));
  await page.route(`${portal.origin}/api/v1/polls?*`, (route) => route.fulfill({ json: { items: [] } }));
  await page.goto(portal.origin);
  const title = page.getByLabel("Poll title");
  await expect(title).toBeVisible();
  const labelHeight = await title.evaluate((input) => input.closest("label")!.getBoundingClientRect().height);
  expect(labelHeight).toBeLessThan(110);
  await expect(page.getByLabel("Eligibility emails")).toBeVisible();
});
