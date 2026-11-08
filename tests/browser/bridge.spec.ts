import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { localOrigins } from "../../packages/config/src/local-dev.js";
import { stubApis, syntheticPoll } from "./fixtures/claim-stubs";

const origins = localOrigins();
const portal = origins.portal.origin;
const respond = origins.respond.origin;
const poll = syntheticPoll();
const { pollId, keyId } = poll;
const otherId = "9b2f4c1e-7d3a-4e8b-a1c2-5f6e7d8c9b0a";
const pollPage = `${respond}/p/${pollId}`;
const bridgeUrl = `${portal}/claim-bridge?pollId=${pollId}`;
const STUB = "<!doctype html><meta charset=utf-8><title>stub</title><body>stub</body>";

test.beforeEach(async ({ context }) => { await stubApis(context, poll); });

async function prepare(page: Page) {
  await page.goto(pollPage);
  await expect(page.getByTestId("capabilities")).toHaveAttribute("data-state", "supported");
  await page.getByRole("button", { name: "Prepare credential" }).click();
  await expect(page.getByTestId("credential")).toHaveAttribute("data-state", "prepared");
}
async function openFromResponse(page: Page) {
  await prepare(page);
  const [popup] = await Promise.all([page.waitForEvent("popup"), page.getByRole("button", { name: "Open claim window" }).click()]);
  return popup;
}

/** Serve a stub document at a real origin path, so messages carry that genuine origin. */
const stubAt = (context: BrowserContext, url: string) =>
  context.route(url, (route) => route.fulfill({ contentType: "text/html", body: STUB }));

/** postMessage from a fresh same-origin grandchild window, so event.source is not the expected window. */
const FROM_OTHER_WINDOW = `(target, message, origin) => {
  const other = window.open("about:blank");
  new other.Function("t", "m", "o", "t.postMessage(m, o)")(target, message, origin);
  other.close();
}`;

test("a click opens the portal bridge with its opener kept and completes the handshake", async ({ page, context }) => {
  const coop: string[] = [];
  context.on("response", (response) => {
    if (response.request().resourceType() === "document") coop.push(response.headers()["cross-origin-opener-policy"] ?? "absent");
  });
  const popup = await openFromResponse(page);
  await expect(popup.getByTestId("bridge")).toHaveAttribute("data-state", "confirming");
  await expect(page.getByTestId("claim-window")).toHaveAttribute("data-state", "request_sent");
  const url = new URL(popup.url());
  expect({ origin: url.origin, pathname: url.pathname, search: url.search }).toEqual({ origin: portal, pathname: "/claim-bridge", search: `?pollId=${pollId}` });
  expect(await popup.evaluate(() => window.opener !== null)).toBe(true);
  await expect(page.getByTestId("claim-window")).toHaveAttribute("data-rejected", "0");
  await expect(popup.getByTestId("bridge")).toHaveAttribute("data-rejected", "0");
  expect(coop).toEqual(["unsafe-none", "unsafe-none"]);
});

test("a direct visit or an extra URL parameter cannot use the bridge", async ({ page }) => {
  await page.goto(bridgeUrl);
  await expect(page.getByTestId("bridge")).toHaveAttribute("data-state", "direct_visit");
  await page.goto(`${bridgeUrl}&channelNonce=AAAA`);
  await expect(page.getByTestId("bridge")).toHaveAttribute("data-state", "invalid_link");
});

test("a blocked popup gives a recoverable instruction and opens nothing", async ({ page, context }) => {
  await page.addInitScript(() => {
    window.open = () => null;
  });
  await prepare(page);
  await page.getByRole("button", { name: "Open claim window" }).click();
  await expect(page.getByTestId("claim-window")).toHaveAttribute("data-state", "popup_blocked");
  await expect(page.getByTestId("claim-window")).toContainText("Allow pop-ups");
  await expect(page.getByRole("button", { name: "Open claim window" })).toBeEnabled();
  expect(context.pages()).toHaveLength(1);
});

for (const [feature, disable] of [
  ["Web Locks", () => Object.defineProperty(Navigator.prototype, "locks", { get: () => undefined, configurable: true })],
  ["IndexedDB", () => Object.defineProperty(window, "indexedDB", { get: () => undefined, configurable: true })],
] as const) {
  test(`without ${feature} the response page refuses to offer a claim`, async ({ page }) => {
    await page.addInitScript(disable);
    await page.goto(pollPage);
    await expect(page.getByTestId("capabilities")).toHaveAttribute("data-state", "unsupported");
    await expect(page.getByTestId("capabilities")).toContainText(feature);
    await expect(page.getByRole("button", { name: /Open claim window|Prepare credential/ })).toHaveCount(0);
  });
}

test("the response page accepts only the opened portal window, exact origin, and expected messages", async ({ page, context }) => {
  await stubAt(context, `${portal}/claim-bridge?*`);
  const stub = await openFromResponse(page);
  const status = page.getByTestId("claim-window");
  const send = (message: unknown) => stub.evaluate(([m, o]) => window.opener.postMessage(m, o), [message, respond] as const);
  const ready = { version: 1, type: "bridge_ready", pollId };

  await stub.evaluate(`(${FROM_OTHER_WINDOW})(window.opener, ${JSON.stringify(ready)}, ${JSON.stringify(respond)})`);
  await page.evaluate((m) => window.postMessage(m, window.location.origin), ready); // wrong origin (self)
  await send({ ...ready, pollId: otherId });
  await send({ version: 1, type: "bridge_ack", pollId, channelNonce: "A".repeat(43) });
  await send({ ...ready, email: "someone@iitgn.ac.in" });
  await send(JSON.stringify(ready));
  await send({ ...ready, padding: "x".repeat(4000) });
  await expect(status).toHaveAttribute("data-rejected", "7");
  // The opened window itself, after navigating to a non-portal origin: right source, wrong origin.
  await stubAt(context, `${respond}/elsewhere`);
  await stub.goto(`${respond}/elsewhere`);
  await stub.evaluate(([m, o]) => window.opener.postMessage(m, o), [ready, respond] as const);
  await expect(status).toHaveAttribute("data-rejected", "8");
  await stub.goto(`${portal}/claim-bridge?pollId=${pollId}`);
  await expect(status).toHaveAttribute("data-state", "waiting_ready");

  await stub.evaluate(() => {
    window.addEventListener("message", (event) => {
      (window as any).__init = { origin: event.origin, fromOpener: event.source === window.opener, data: event.data };
    });
  });
  await send(ready);
  await expect(status).toHaveAttribute("data-state", "waiting_ack");
  const init = await stub.evaluate(() => (window as any).__init);
  expect(init).toMatchObject({ origin: respond, fromOpener: true, data: { version: 1, type: "bridge_init", pollId, keyId } });
  expect(Object.keys(init.data).sort()).toEqual(["channelNonce", "keyId", "pollId", "type", "version"]);
  expect(Buffer.from(init.data.channelNonce, "base64url")).toHaveLength(32);

  await send({ version: 1, type: "bridge_ack", pollId, channelNonce: Buffer.alloc(32, 9).toString("base64url") });
  await expect(status).toHaveAttribute("data-rejected", "9");
  await expect(status).toHaveAttribute("data-state", "waiting_ack");
  await send({ version: 1, type: "bridge_ack", pollId, channelNonce: init.data.channelNonce });
  await expect(status).toHaveAttribute("data-state", "request_sent");
});

test("the bridge accepts one init only from its opener at the response origin, for its own poll and key", async ({ page, context }) => {
  await stubAt(context, `${respond}/stub-opener`);
  await page.goto(`${respond}/stub-opener`);
  await page.evaluate(() => {
    (window as any).__messages = [];
    window.addEventListener("message", (event) => {
      (window as any).__messages.push({ origin: event.origin, fromBridge: event.source === (window as any).__bridge, data: event.data });
    });
  });
  const [bridge] = await Promise.all([
    page.waitForEvent("popup"),
    page.evaluate((url) => ((window as any).__bridge = window.open(url, "spike-bridge")), bridgeUrl),
  ]);
  const status = bridge.getByTestId("bridge");
  await expect(status).toHaveAttribute("data-state", "waiting_init");
  await expect.poll(() => page.evaluate(() => (window as any).__messages)).toEqual([
    { origin: portal, fromBridge: true, data: { version: 1, type: "bridge_ready", pollId } },
  ]);

  const nonce = Buffer.alloc(32, 5).toString("base64url");
  const init = { version: 1, type: "bridge_init", pollId, channelNonce: nonce, keyId };
  const send = (message: unknown) => page.evaluate(([m, o]) => (window as any).__bridge.postMessage(m, o), [message, portal] as const);
  await send({ ...init, keyId: otherId });
  await send({ ...init, pollId: otherId });
  await send({ ...init, channelNonce: "short" });
  await page.evaluate(`(${FROM_OTHER_WINDOW})(window.__bridge, ${JSON.stringify(init)}, ${JSON.stringify(portal)})`);
  await bridge.evaluate((m) => window.postMessage(m, window.location.origin), init); // wrong origin (self)
  await expect(status).toHaveAttribute("data-rejected", "5");
  // The opener itself, after navigating to the portal origin: right source, wrong origin.
  await stubAt(context, `${portal}/elsewhere`);
  await page.goto(`${portal}/elsewhere`);
  await page.evaluate(([m, o]) => window.open("", "spike-bridge")!.postMessage(m, o), [init, portal] as const);
  await expect(status).toHaveAttribute("data-rejected", "6");
  await expect(status).toHaveAttribute("data-state", "waiting_init");
  await page.goto(`${respond}/stub-opener`);
  await page.evaluate(() => {
    (window as any).__bridge = window.open("", "spike-bridge");
    (window as any).__messages = [];
    window.addEventListener("message", (event) => {
      (window as any).__messages.push({ origin: event.origin, fromBridge: event.source === (window as any).__bridge, data: event.data });
    });
  });

  await send(init);
  await expect(status).toHaveAttribute("data-state", "connected");
  await expect.poll(() => page.evaluate(() => (window as any).__messages.length)).toBe(1);
  expect((await page.evaluate(() => (window as any).__messages))[0]).toEqual({
    origin: portal, fromBridge: true, data: { version: 1, type: "bridge_ack", pollId, channelNonce: nonce },
  });
  await send(init); // a second init on the same channel
  await expect(status).toHaveAttribute("data-rejected", "7");
  expect(await page.evaluate(() => (window as any).__messages.length)).toBe(1);
});

test("reloading a connected bridge closes the channel instead of silently reconnecting", async ({ page }) => {
  const popup = await openFromResponse(page);
  await expect(page.getByTestId("claim-window")).toHaveAttribute("data-state", "request_sent");
  await popup.reload();
  await expect(page.getByTestId("claim-window")).toHaveAttribute("data-state", "connection_lost");
  await expect(popup.getByTestId("bridge")).toHaveAttribute("data-state", "waiting_init");
});

test("a COOP header that severs the opener breaks the handshake (the header check is load-bearing)", async ({ page, context }) => {
  await context.route(`${portal}/claim-bridge?*`, async (route) => {
    // The Node side can't resolve the .test names; fetch the same path via loopback.
    const response = await route.fetch({ url: route.request().url().replace(portal, `https://127.0.0.1:${origins.portal.port}`) });
    await route.fulfill({ response, headers: { ...response.headers(), "cross-origin-opener-policy": "same-origin" } });
  });
  const popup = await openFromResponse(page);
  await expect(popup.getByTestId("bridge")).toHaveAttribute("data-state", "direct_visit");
  expect(await popup.evaluate(() => window.opener)).toBeNull();
  await expect(page.getByTestId("claim-window")).not.toHaveAttribute("data-state", "connected");
});
