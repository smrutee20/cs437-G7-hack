// Issuer-side client for the private native signer, against the real pinned workerd.
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, inject, test } from "vitest";
import {
  blindMessage, finalizeSignature, importPollPublicKey, prepareMessage, verifySignature,
} from "../../packages/protocol/src/blind";
import { encodeApplicationMessage } from "../../packages/protocol/src/credential";
import { loadPrivateKey, provisionPollKey } from "../../services/portal-api/src/keys";
import { createSignerClient } from "../../services/portal-api/src/signer-client";

const url = inject("signerUrl"), token = inject("signerToken"), master = randomBytes(32);
let directory: string, silent: Server, silentUrl: string;
const stalledSockets = new Set<Socket>();
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "feedback-signer-client-"));
  await chmod(directory, 0o700);
  // Accepts TCP connections and never answers: an unresponsive signer.
  silent = createServer((socket) => { stalledSockets.add(socket); });
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  silentUrl = `http://127.0.0.1:${(silent.address() as { port: number }).port}`;
});
afterAll(async () => {
  for (const socket of stalledSockets) socket.destroy();
  await new Promise((resolve) => silent?.close(resolve));
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function blindedFor(publicJwk: { kty: "RSA"; n: string; e: "AQAB" }) {
  const key = await importPollPublicKey(publicJwk);
  const prepared = prepareMessage(encodeApplicationMessage(randomUUID(), randomBytes(32)));
  return { key, prepared, ...(await blindMessage(key, prepared)) };
}

test("a provisioned poll key signs a browser-style blinded request natively; the finalized credential verifies", async () => {
  const provisioned = await provisionPollKey(directory, master);
  const signer = createSignerClient({ url, token, timeoutMs: 5000 });
  expect(await signer.healthy()).toBe(true);
  const request = await blindedFor(provisioned.publicJwk);
  const der = await loadPrivateKey(directory, master, provisioned.privateSecretRef);
  const blindSignature = await signer.sign(der, request.blindedMessage);
  expect(blindSignature).toHaveLength(384);
  const signature = await finalizeSignature(request.key, request.prepared, blindSignature, request.inverse);
  expect(await verifySignature(request.key, request.prepared, signature)).toBe(true);
});

test("wrong credential, refused input, or an unresponsive signer fail generically and within the timeout", async () => {
  const provisioned = await provisionPollKey(directory, master);
  const der = await loadPrivateKey(directory, master, provisioned.privateSecretRef);
  const request = await blindedFor(provisioned.publicJwk);
  const impostor = createSignerClient({ url, token: randomBytes(32).toString("base64url"), timeoutMs: 5000 });
  expect(await impostor.healthy()).toBe(false);
  await expect(impostor.sign(der, request.blindedMessage)).rejects.toThrow(/^signer unavailable$/);
  const signer = createSignerClient({ url, token, timeoutMs: 5000 });
  await expect(signer.sign(der, new Uint8Array(384))).rejects.toThrow(/^signer unavailable$/); // m = 0 refused
  await expect(signer.sign(Buffer.from("not a key"), request.blindedMessage)).rejects.toThrow(/^signer unavailable$/);

  const stalled = createSignerClient({ url: silentUrl, token, timeoutMs: 300 });
  const started = performance.now();
  expect(await stalled.healthy()).toBe(false);
  await expect(stalled.sign(der, request.blindedMessage)).rejects.toThrow(/^signer unavailable$/);
  expect(performance.now() - started).toBeLessThan(3000); // two bounded calls, generous margin
});

test("only a loopback signer with a strong service credential is accepted", () => {
  for (const bad of ["http://10.0.0.5:8790", "http://localhost:8790", "https://127.0.0.1:8790",
    "http://user:pass@127.0.0.1:8790", "http://127.0.0.1:8790/prefix", "http://127.0.0.1:8790/?x=1"]) {
    expect(() => createSignerClient({ url: bad, token, timeoutMs: 1000 })).toThrow();
  }
  expect(() => createSignerClient({ url, token: "short", timeoutMs: 1000 })).toThrow();
  expect(() => createSignerClient({ url, token, timeoutMs: 0 })).toThrow();
  expect(() => createSignerClient({ url: "http://[::1]:8790", token, timeoutMs: 1000 })).not.toThrow();
});
