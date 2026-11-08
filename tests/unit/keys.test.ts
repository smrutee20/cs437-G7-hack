import { createHash, createPrivateKey, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { loadPrivateKey, provisionPollKey } from "../../services/portal-api/src/keys";

const directories: string[] = [];
afterAll(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });
const directory = async () => { const dir = await mkdtemp(join(tmpdir(), "feedback-keys-")); directories.push(dir); return dir; };

test("two provisioned poll keys are independent, encrypted at rest and load across restart", async () => {
  const dir = await directory(), master = randomBytes(32);
  const a = await provisionPollKey(dir, master);
  const b = await provisionPollKey(dir, master);
  expect(a.keyId).not.toBe(b.keyId);
  expect(a.fingerprint).not.toEqual(b.fingerprint);
  expect(a.publicJwk).toMatchObject({ kty: "RSA", e: "AQAB" });
  expect(Buffer.from(a.publicJwk.n, "base64url")).toHaveLength(384);
  const expected = createHash("sha256").update(JSON.stringify({e:"AQAB",kty:"RSA",n:a.publicJwk.n})).digest();
  expect(a.fingerprint).toEqual(expected);
  const disk = await readFile(join(dir, a.privateSecretRef));
  expect((await stat(join(dir, a.privateSecretRef))).mode & 0o777).toBe(0o600);
  expect((await stat(dir)).mode & 0o777).toBe(0o700);
  const restored = await loadPrivateKey(dir, master, a.privateSecretRef);
  expect(disk.includes(restored)).toBe(false);
  expect(createPrivateKey({ key: restored, type: "pkcs8", format: "der" }).asymmetricKeyDetails?.modulusLength).toBe(3072);
  expect(createPrivateKey({ key: restored, type: "pkcs8", format: "der" }).export({format:"jwk"}).n).toBe(a.publicJwk.n);
  await expect(loadPrivateKey(dir, randomBytes(32), a.privateSecretRef)).rejects.toThrow();
  await expect(loadPrivateKey(dir, master, "../escape")).rejects.toThrow();
  expect((await loadPrivateKey(dir, master, b.privateSecretRef))).not.toEqual(restored);
});
