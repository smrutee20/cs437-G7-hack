import { expect, test } from "@playwright/test";
import { localOrigins } from "../../packages/config/src/local-dev.js";

const origins = localOrigins();
const portal = origins.portal.origin;
const respond = origins.respond.origin;

test("portal host-only cookie does not reach the response hostname", async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    await context.addCookies([{
      name: "__Host-session",
      value: "local-fixture-only",
      url: portal,
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    }]);
    const page = await context.newPage();
    await page.goto(portal);
    expect(new URL(page.url()).hostname).toBe(origins.portal.hostname);
    const responseRequests: Promise<string | undefined>[] = [];
    context.on("request", (request) => {
      if (new URL(request.url()).hostname === origins.respond.hostname) {
        responseRequests.push(request.allHeaders().then((headers) => headers.cookie));
      }
    });
    await page.goto(respond);
    expect(new URL(page.url()).hostname).toBe(origins.respond.hostname);
    await expect(page.locator("main")).toBeVisible();
    expect(responseRequests.length).toBeGreaterThan(0);
    for (const header of await Promise.all(responseRequests)) {
      expect(header ?? "").not.toContain("local-fixture-only");
    }
    expect(await page.evaluate(() => ({
      crypto: !!crypto.subtle,
      storage: !!indexedDB,
      locks: !!navigator.locks,
    }))).toEqual({ crypto: true, storage: true, locks: true });
  } finally {
    await context.close();
  }
});
