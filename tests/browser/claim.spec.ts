// SPEC.md §8 claim flow across the two real origins, with stubbed same-origin APIs.
import { createPublicKey } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { parsePreparedMessage } from "../../packages/protocol/src/credential";
import { nodeVerifyPss } from "../fixtures/rsa";
import { CSRF, PARTICIPANT, portal, respond, stubApis, syntheticPoll, type SyntheticPoll } from "./fixtures/claim-stubs";

const STUB = "<!doctype html><meta charset=utf-8><title>stub</title><body>stub</body>";

/** The stored record with byte fields as base64url, read straight from the response origin's IndexedDB. */
const readRecord = (page: Page, pollId: string) => page.evaluate((id) => new Promise<Record<string, unknown> | null>((resolve, reject) => {
  const open = indexedDB.open("iitgn-feedback");
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains("credentials")) { db.close(); return resolve(null); }
    const get = db.transaction("credentials").objectStore("credentials").get(id);
    get.onsuccess = () => {
      db.close();
      const value = get.result;
      if (!value) return resolve(null);
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(value)) {
        out[key] = field instanceof Uint8Array ? btoa(String.fromCharCode(...field)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : field;
      }
      resolve(out);
    };
  };
}), pollId);

async function prepared(page: Page, poll: SyntheticPoll) {
  await page.goto(`${respond}/p/${poll.pollId}`);
  await expect(page.getByTestId("capabilities")).toHaveAttribute("data-state", "supported");
  await page.getByRole("button", { name: "Prepare my credential" }).click();
  await expect(page.getByTestId("credential")).toHaveAttribute("data-state", "prepared");
}
async function openBridge(page: Page) {
  const [popup] = await Promise.all([page.waitForEvent("popup"), page.getByRole("button", { name: "Open claim window" }).click()]);
  return popup;
}
const bytes = (text: unknown) => Buffer.from(text as string, "base64url");

test("an eligible participant obtains, verifies and stores one credential; the bridge closes after stored_ack", async ({ page, context }) => {
  const poll = syntheticPoll();
  const { calls } = await stubApis(context, poll);
  await prepared(page, poll);
  const before = await readRecord(page, poll.pollId);
  expect(Object.keys(before!).sort()).toEqual(["blinded", "closesAt", "inverse", "keyId", "keyVersion", "pollId", "prepared", "state"]);
  const popup = await openBridge(page);
  const bridge = popup.getByTestId("bridge");
  await expect(bridge).toHaveAttribute("data-state", "confirming");
  // The confirmation shows the poll title next to the signed-in account (design: the issuing desk).
  await expect(popup.getByRole("heading", { level: 1 })).toContainText(poll.title);
  await expect(popup.getByRole("main")).toContainText(PARTICIPANT);
  // claim_sent is durable before the request reaches the bridge, and nothing is claimed before confirmation.
  expect(await readRecord(page, poll.pollId)).toMatchObject({ state: "claim_sent", prepared: before!.prepared });
  expect(calls).toHaveLength(0);

  const closed = popup.waitForEvent("close");
  await popup.getByRole("button", { name: "Stamp my envelope" }).click();
  await closed;
  await expect(page.getByTestId("credential")).toHaveAttribute("data-state", "usable");
  expect(calls).toHaveLength(1);
  expect(calls[0].headers).toMatchObject({ "x-csrf-token": CSRF, "content-type": "application/json", origin: portal });
  expect(new URL(calls[0].url).search).toBe("");
  expect(Object.keys(calls[0].body as object).sort()).toEqual(["blindedMessage", "keyId", "keyVersion"]);
  expect(calls[0].body).toEqual({ keyId: poll.keyId, keyVersion: 1, blindedMessage: before!.blinded });

  const usable = await readRecord(page, poll.pollId);
  // The blinding inverse and blinded request are erased once the credential is stored.
  expect(Object.keys(usable!).sort()).toEqual(["closesAt", "keyId", "keyVersion", "pollId", "prepared", "signature", "state"]);
  expect(usable!.prepared).toBe(before!.prepared);
  const publicKey = createPublicKey({ key: poll.publicJwk, format: "jwk" });
  expect(nodeVerifyPss(publicKey, bytes(usable!.prepared), bytes(usable!.signature))).toBe(true);
  expect(parsePreparedMessage(bytes(usable!.prepared), poll.pollId).keyVersion).toBe(1);
  await expect(page.getByRole("button", { name: "Open claim window" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Prepare my credential" })).toHaveCount(0);
});

test("cancelling in the bridge sends nothing to the server and permits an explicit retry", async ({ page, context }) => {
  const poll = syntheticPoll();
  const { calls } = await stubApis(context, poll);
  await prepared(page, poll);
  const first = await openBridge(page);
  await expect(first.getByTestId("bridge")).toHaveAttribute("data-state", "confirming");
  const closed = first.waitForEvent("close");
  await first.getByRole("button", { name: "Cancel" }).click();
  await closed;
  await expect(page.getByTestId("credential")).toHaveAttribute("data-state", "prepared");
  await expect(page.getByTestId("claim-message")).toContainText("No claim was made");
  expect(calls).toHaveLength(0);
  const second = await openBridge(page);
  await second.getByRole("button", { name: "Stamp my envelope" }).click();
  await expect(page.getByTestId("credential")).toHaveAttribute("data-state", "usable");
  expect(calls).toHaveLength(1);
});

test("signed out, the bridge asks for sign-in and the response returns to prepared without a claim", async ({ page, context }) => {
  const poll = syntheticPoll();
  const { calls } = await stubApis(context, poll, { signedIn: false });
  await prepared(page, poll);
  const popup = await openBridge(page);
  await expect(page.getByTestId("credential")).toHaveAttribute("data-state", "prepared");
  await expect(page.getByTestId("claim-message")).toContainText("Sign in to the portal");
  // The bridge answered login_required without any HTTP attempt, then closed on stored_ack.
  await expect.poll(() => popup.isClosed()).toBe(true);
  expect(calls).toHaveLength(0);
});

test("a consumed entitlement is terminal for this browser and erases the secret", async ({ page, context }) => {
  const poll = syntheticPoll();
  const { calls } = await stubApis(context, poll, {
    claim: () => ({ status: 409, body: { error: { code: "claim_consumed", message: "claim consumed" } } }),
  });
  await prepared(page, poll);
  const popup = await openBridge(page);
  await popup.getByRole("button", { name: "Stamp my envelope" }).click();
  await expect(page.getByTestId("credential")).toHaveAttribute("data-state", "claim_consumed");
  expect(Object.keys((await readRecord(page, poll.pollId))!).sort()).toEqual(["closesAt", "pollId", "state"]);
  await expect(page.getByRole("button", { name: /Open claim window|Prepare my credential/ })).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("credential")).toHaveAttribute("data-state", "claim_consumed");
  expect(calls).toHaveLength(1);
});

test("an uncertain claim is never retried; after two minutes only a non-secret claim_uncertain marker remains", async ({ page, context }) => {
  const poll = syntheticPoll();
  const { calls } = await stubApis(context, poll, { claim: () => null }); // connection reset: outcome unknown
  await page.clock.install();
  await prepared(page, poll);
  const popup = await openBridge(page);
  await popup.getByRole("button", { name: "Stamp my envelope" }).click();
  await expect(page.getByTestId("claim-message")).toContainText("outcome of this claim is unknown");
  await expect(page.getByTestId("credential")).toHaveAttribute("data-state", "claim_sent");
  await expect(page.getByRole("button", { name: /Open claim window|Prepare my credential/ })).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("credential")).toHaveAttribute("data-state", "claim_sent");
  await page.clock.fastForward("02:01");
  await expect(page.getByTestId("credential")).toHaveAttribute("data-state", "claim_uncertain");
  expect(Object.keys((await readRecord(page, poll.pollId))!).sort()).toEqual(["closesAt", "pollId", "state"]);
  expect(calls).toHaveLength(1);
});

for (const failure of ["throws", "is silently lost"] as const) test(`if the claim_sent write ${failure}, no claim request is sent`, async ({ page, context }) => {
  const poll = syntheticPoll();
  const { calls } = await stubApis(context, poll);
  await prepared(page, poll);
  await page.evaluate((mode) => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if ((value as { state?: string })?.state !== "claim_sent") return put.call(this, value, key);
      if (mode === "throws") throw new DOMException("simulated", "QuotaExceededError");
      // A write that "succeeds" but does not persist what was asked: only read-back can notice.
      return put.call(this, { ...(value as object), state: "prepared", sentAt: undefined }, key);
    };
  }, failure);
  const popup = await openBridge(page);
  await expect(page.getByTestId("claim-message")).toContainText("could not be saved");
  await expect(popup.getByTestId("bridge")).toHaveAttribute("data-state", "connected");
  await expect(page.getByTestId("credential")).toHaveAttribute("data-state", "prepared");
  await expect(popup.getByRole("button", { name: "Stamp my envelope" })).toHaveCount(0);
  expect(calls).toHaveLength(0);
});

test("two tabs share one prepared credential, never overwrite each other, and see the other's progress", async ({ context }) => {
  const poll = syntheticPoll();
  await stubApis(context, poll);
  const [a, b] = [await context.newPage(), await context.newPage()];
  for (const tab of [a, b]) {
    await tab.goto(`${respond}/p/${poll.pollId}`);
    await expect(tab.getByTestId("capabilities")).toHaveAttribute("data-state", "supported");
  }
  await Promise.all([a, b].map((tab) => tab.getByRole("button", { name: "Prepare my credential" }).click()));
  for (const tab of [a, b]) await expect(tab.getByTestId("credential")).toHaveAttribute("data-state", "prepared");
  const first = await readRecord(a, poll.pollId);
  // A stale tab acting on old UI state must get the existing record back, not replace it.
  // The response dev server serves the app's own module; the path is a browser URL, not a Node import.
  const stalePrepare = (tab: Page) => tab.evaluate(async ({ dto, module }) => {
    const flow = await import(module);
    return (await flow.prepareCredential(dto)).state as string;
  }, { dto: poll.dto, module: "/src/claim-flow.ts" });
  expect(await stalePrepare(b)).toBe("prepared");
  expect(await readRecord(b, poll.pollId)).toEqual(first);
  const popup = await openBridge(a);
  await popup.getByRole("button", { name: "Stamp my envelope" }).click();
  await expect(a.getByTestId("credential")).toHaveAttribute("data-state", "usable");
  await expect(b.getByTestId("credential")).toHaveAttribute("data-state", "usable");
  const usable = await readRecord(a, poll.pollId);
  expect(await stalePrepare(b)).toBe("usable");
  expect(await readRecord(a, poll.pollId)).toEqual(usable);
});

/** A stub response-origin page that drives the real bridge by hand. */
async function driveBridge(page: Page, context: BrowserContext, poll: SyntheticPoll) {
  await context.route(`${respond}/stub-opener`, (route) => route.fulfill({ contentType: "text/html", body: STUB }));
  await page.goto(`${respond}/stub-opener`);
  await page.evaluate(() => {
    (window as any).__messages = [];
    window.addEventListener("message", (event) => { (window as any).__messages.push(event.data); });
  });
  const [bridge] = await Promise.all([page.waitForEvent("popup"),
    page.evaluate((url) => ((window as any).__bridge = window.open(url, "bridge")), `${portal}/claim-bridge?pollId=${poll.pollId}`)]);
  await expect.poll(() => page.evaluate(() => (window as any).__messages.length)).toBe(1);
  const send = (message: unknown) => page.evaluate(([m, o]) => (window as any).__bridge.postMessage(m, o), [message, portal] as const);
  const channelNonce = Buffer.alloc(32, 5).toString("base64url");
  await send({ version: 1, type: "bridge_init", pollId: poll.pollId, channelNonce, keyId: poll.keyId });
  await expect(bridge.getByTestId("bridge")).toHaveAttribute("data-state", "connected");
  const messages = () => page.evaluate(() => (window as any).__messages as Record<string, unknown>[]);
  return { bridge, send, channelNonce, messages };
}

test("the bridge accepts one valid claim_request, makes one HTTP claim, and resends the same result until stored_ack", async ({ page, context }) => {
  const poll = syntheticPoll();
  const { calls } = await stubApis(context, poll);
  const { bridge, send, channelNonce, messages } = await driveBridge(page, context, poll);
  const blinded = Buffer.concat([Buffer.alloc(1), Buffer.alloc(383, 0x42)]).toString("base64url"); // < n
  const request = { version: 1, type: "claim_request", pollId: poll.pollId, channelNonce, keyId: poll.keyId, keyVersion: 1, blindedMessage: blinded };
  const status = bridge.getByTestId("bridge");
  await send({ ...request, channelNonce: Buffer.alloc(32, 6).toString("base64url") });
  await send({ ...request, keyId: poll.pollId });
  await send({ ...request, secret: "AAAA" });
  await expect(status).toHaveAttribute("data-rejected", "3");
  await expect(status).toHaveAttribute("data-state", "connected");
  await send(request);
  await expect(status).toHaveAttribute("data-state", "confirming");
  await send(request); // a second request on this channel
  await expect(status).toHaveAttribute("data-rejected", "4");
  await bridge.getByRole("button", { name: "Stamp my envelope" }).click();
  await expect.poll(async () => (await messages()).filter((m) => m.type === "claim_result").length, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(2);
  const results = (await messages()).filter((m) => m.type === "claim_result");
  expect(results.every((m) => JSON.stringify(m) === JSON.stringify(results[0]))).toBe(true);
  expect(Object.keys(results[0]).sort()).toEqual(["blindSignature", "channelNonce", "pollId", "type", "version"]);
  expect(calls).toHaveLength(1);
  const closed = bridge.waitForEvent("close");
  await send({ version: 1, type: "stored_ack", pollId: poll.pollId, channelNonce });
  await closed;
  expect(calls).toHaveLength(1);
});

test("the response ignores a result with the wrong nonce and never stores a signature that fails to verify", async ({ page, context }) => {
  const poll = syntheticPoll();
  await stubApis(context, poll);
  await context.route(`${portal}/claim-bridge?*`, (route) => route.fulfill({ contentType: "text/html", body: STUB }));
  await prepared(page, poll);
  const stub = await openBridge(page);
  await stub.evaluate(() => {
    (window as any).__got = [];
    window.addEventListener("message", (event) => { (window as any).__got.push(event.data); });
  });
  const send = (message: unknown) => stub.evaluate(([m, o]) => window.opener.postMessage(m, o), [message, respond] as const);
  const got = () => stub.evaluate(() => (window as any).__got as Record<string, any>[]);
  await send({ version: 1, type: "bridge_ready", pollId: poll.pollId });
  await expect.poll(async () => (await got()).length).toBe(1);
  const nonce = (await got())[0].channelNonce;
  await send({ version: 1, type: "bridge_ack", pollId: poll.pollId, channelNonce: nonce });
  await expect.poll(async () => (await got()).map((m) => m.type)).toEqual(["bridge_init", "claim_request"]);
  const status = page.getByTestId("claim-window");
  const result = { version: 1, type: "claim_result", pollId: poll.pollId, channelNonce: nonce,
    blindSignature: Buffer.concat([Buffer.alloc(1), Buffer.alloc(383, 7)]).toString("base64url") };
  await send({ ...result, channelNonce: Buffer.alloc(32, 1).toString("base64url") });
  await expect(status).toHaveAttribute("data-rejected", "1");
  await expect(page.getByTestId("credential")).toHaveAttribute("data-state", "claim_sent");
  await send(result); // right channel, but not a valid signature on this credential
  await expect(page.getByTestId("credential")).toHaveAttribute("data-state", "claim_consumed");
  await expect(page.getByTestId("claim-message")).toContainText("did not verify");
  expect(Object.keys((await readRecord(page, poll.pollId))!).sort()).toEqual(["closesAt", "pollId", "state"]);
});
