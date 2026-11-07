import type { KeyObject } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { localOrigins } from "../../packages/config/src/local-dev.js";
import { parsePreparedMessage } from "../../packages/protocol/src/credential";
import { rfc9474A1 as v } from "../fixtures/rfc9474-a1";
import { freshKey, nodeVerifyPss } from "../fixtures/rsa";

const respond = localOrigins().respond.origin;
const signerUrl = `http://127.0.0.1:${process.env.FEEDBACK_TEST_SIGNER_PORT}`;
const signerToken = process.env.FEEDBACK_TEST_SIGNER_TOKEN ?? "";
const pollId = "123e4567-e89b-42d3-a456-426614174000";
// SPEC.md §7 fixture constants (independent of the code under test).
const messageHex = "494954474e2d464545444241434b2d43524544454e5449414c0001123e4567e89b42d3a45642661417400000000001000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const nullifierHex = "5b42afa082f7f1fdcd75b36ffe14923fe7a9759a8971e8223b3d1e2c300d973c";

/** Loads the response app's protocol module from the dev server plus tiny IndexedDB helpers. */
async function loadProtocol(page: Page) {
  await page.goto(respond);
  await page.addScriptTag({
    type: "module",
    content: `
      import * as protocol from "/src/protocol.ts";
      const open = () => new Promise((resolve, reject) => {
        const request = indexedDB.open("interop-spike", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("credentials", { keyPath: "pollId" });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const run = (mode, op) => open().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction("credentials", mode);
        const request = op(tx.objectStore("credentials"));
        tx.oncomplete = () => { db.close(); resolve(request.result); };
        tx.onerror = () => reject(tx.error);
      }));
      window.__spike = {
        protocol,
        put: (record) => run("readwrite", (store) => store.put(record)),
        get: (key) => run("readonly", (store) => store.get(key)),
        drop: () => new Promise((resolve) => { const r = indexedDB.deleteDatabase("interop-spike"); r.onsuccess = r.onerror = () => resolve(); }),
      };`,
  });
  await page.waitForFunction(() => "__spike" in window);
}

test("§7 fixture and RFC 9474 A.1 finalization run in the browser", async ({ page }) => {
  await loadProtocol(page);
  const result = await page.evaluate(async ({ v, pollId }) => {
    const { protocol: p } = (window as unknown as { __spike: any }).__spike;
    const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    const fromHex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
    const b64u = (h: string) => btoa(String.fromCharCode(...fromHex(h))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const secret = Uint8Array.from({ length: 32 }, (_, i) => i);
    const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: b64u(v.n), e: b64u(v.e) }, { name: "RSA-PSS", hash: "SHA-384" }, true, ["verify"]);
    const sig = await p.finalizeSignature(key, fromHex(v.prepared_msg), fromHex(v.blind_sig), fromHex(v.inv));
    return {
      message: hex(p.encodeApplicationMessage(pollId, secret)),
      nullifier: hex(await p.computeNullifier(pollId, secret)),
      sig: hex(sig),
      verified: await p.verifySignature(key, fromHex(v.prepared_msg), sig),
    };
  }, { v, pollId });
  expect(result).toEqual({ message: messageHex, nullifier: nullifierHex, sig: v.sig, verified: true });
});

test("browser blinds → native workerd signer signs → browser finalizes after IndexedDB restore", async ({ page }) => {
  const poll = freshKey();
  await loadProtocol(page);

  const first = await page.evaluate(async ({ jwk, pollId }) => {
    const { protocol: p, put, get } = (window as unknown as { __spike: any }).__spike;
    const key = await p.importPollPublicKey(jwk);
    const prepared = p.prepareMessage(p.encodeApplicationMessage(pollId, crypto.getRandomValues(new Uint8Array(32))));
    const { blindedMessage, inverse } = await p.blindMessage(key, prepared);
    await put({ pollId, jwk, prepared, inverse });
    const back = await get(pollId);
    if (!(back.prepared instanceof Uint8Array) || p.encodeBase64Url(back.prepared) !== p.encodeBase64Url(prepared)) {
      throw new Error("read-back mismatch");
    }
    return { prepared: p.encodeBase64Url(prepared), blindedMessage: p.encodeBase64Url(blindedMessage) };
  }, { jwk: poll.jwk, pollId });

  const response = await fetch(`${signerUrl}/blind-sign`, {
    method: "POST",
    headers: { authorization: `Bearer ${signerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ privateKeyPkcs8: Buffer.from(poll.pkcs8).toString("base64url"), blindedMessage: first.blindedMessage }),
  });
  expect(response.status).toBe(200);
  const { blindSignature } = (await response.json()) as { blindSignature: string };

  await page.reload();
  await loadProtocol(page);
  const second = await page.evaluate(async ({ pollId, blindSignature }) => {
    const { protocol: p, get, drop } = (window as unknown as { __spike: any }).__spike;
    const record = await get(pollId);
    const key = await p.importPollPublicKey(record.jwk);
    const signature = await p.finalizeSignature(key, record.prepared, p.decodeBase64Url(blindSignature, 384), record.inverse);
    const verified = await p.verifySignature(key, record.prepared, signature);
    await drop();
    return { prepared: p.encodeBase64Url(record.prepared), signature: p.encodeBase64Url(signature), verified };
  }, { pollId, blindSignature });

  expect(second.verified).toBe(true);
  expect(second.prepared).toBe(first.prepared); // random prefix retained through persistence
  const prepared = Uint8Array.from(Buffer.from(second.prepared, "base64url"));
  expect(nodeVerifyPss(poll.publicKey as unknown as KeyObject, prepared, Buffer.from(second.signature, "base64url"))).toBe(true);
  expect(parsePreparedMessage(prepared, pollId).pollId).toBe(pollId);
});
