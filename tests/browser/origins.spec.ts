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

    const responseRequests: Promise<{ kind: string; cookie: string | undefined }>[] = [];
    context.on("request", (request) => {
      if (new URL(request.url()).hostname === origins.respond.hostname) {
        responseRequests.push(request.allHeaders().then((headers) => ({ kind: request.resourceType(), cookie: headers.cookie })));
      }
    });
    await page.goto(respond);
    expect(new URL(page.url()).hostname).toBe(origins.respond.hostname);
    await expect(page.locator("main")).toBeVisible();
    // A same-origin API request (no API exists yet; the outgoing request is what's inspected).
    expect(await page.evaluate(() => fetch("/api/v1/polls/123e4567-e89b-42d3-a456-426614174000/public").then((r) => r.status))).toBeGreaterThan(0);
    expect(await page.evaluate(() => ({ crypto: !!crypto.subtle, storage: !!indexedDB, locks: !!navigator.locks })))
      .toEqual({ crypto: true, storage: true, locks: true });

    const seen = await Promise.all(responseRequests);
    expect([...new Set(seen.map((request) => request.kind))]).toEqual(expect.arrayContaining(["document", "script", "fetch"]));
    for (const request of seen) expect(request.cookie ?? "").not.toContain("local-fixture-only");

    // Positive control: the same cookie *is* sent to the portal host, so its absence above is meaningful.
    const portalRequest = page.waitForRequest((request) => new URL(request.url()).hostname === origins.portal.hostname);
    await page.goto(portal);
    expect((await (await portalRequest).allHeaders()).cookie ?? "").toContain("local-fixture-only");
  } finally {
    await context.close();
  }
});
