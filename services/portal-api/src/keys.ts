// Private PKCS#8 is stored outside Postgres and the web roots. Supply a
// persistent, independently protected 32-byte encryption key at deployment.
import { createCipheriv, createDecipheriv, createHash, generateKeyPair, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const generate = promisify(generateKeyPair);
const KEY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function checkStore(directory: string, encryptionKey: Buffer): Promise<void> {
  if (!Buffer.isBuffer(encryptionKey) || encryptionKey.length !== 32) throw new Error("key store unavailable");
  const dir = await lstat(directory);
  if (!dir.isDirectory() || (dir.mode & 0o777) !== 0o700 || (process.getuid?.() !== undefined && dir.uid !== process.getuid())) {
    throw new Error("key store unavailable");
  }
}

export async function provisionPollKey(directory: string, encryptionKey: Buffer): Promise<{
  keyId: string; publicJwk: { kty: "RSA"; n: string; e: "AQAB" }; fingerprint: Buffer; privateSecretRef: string;
}> {
  await checkStore(directory, encryptionKey);
  const { publicKey, privateKey } = await generate("rsa", { modulusLength: 3072, publicExponent: 65537 });
  const { kty, n, e } = publicKey.export({ format: "jwk" });
  if (kty !== "RSA" || typeof n !== "string" || e !== "AQAB" || Buffer.from(n, "base64url").length !== 384) {
    throw new Error("key generation failed");
  }
  const publicJwk = { kty: "RSA" as const, n, e: "AQAB" as const };
  const fingerprint = createHash("sha256").update(JSON.stringify({ e, kty, n }), "utf8").digest();
  const keyId = randomUUID();
  const der = privateKey.export({ type: "pkcs8", format: "der" });
  const nonce = randomBytes(12);
  let payload: Buffer;
  try {
    const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
    const encrypted = Buffer.concat([cipher.update(der), cipher.final()]);
    payload = Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), encrypted]);
  } finally {
    der.fill(0);
  }
  const path = join(directory, keyId);
  const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(payload);
    await file.sync();
  } catch (error) {
    await file.close();
    await unlink(path);
    throw error;
  }
  await file.close();
  // Durable directory entry before publishing the public key / DB reference.
  const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await dir.sync(); } finally { await dir.close(); }
  return { keyId, publicJwk, fingerprint, privateSecretRef: keyId };
}

export async function loadPrivateKey(directory: string, encryptionKey: Buffer, ref: string): Promise<Buffer> {
  await checkStore(directory, encryptionKey);
  if (!KEY_ID.test(ref)) throw new Error("invalid private key reference");
  const file = await open(join(directory, ref), constants.O_RDONLY | constants.O_NOFOLLOW);
  let payload: Buffer;
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.size < 30 || info.size > 4096 ||
        (process.getuid?.() !== undefined && info.uid !== process.getuid())) throw new Error("key store unavailable");
    payload = await file.readFile();
  } finally { await file.close(); }
  if (payload[0] !== 1) throw new Error("invalid key store version");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey, payload.subarray(1, 13));
  decipher.setAuthTag(payload.subarray(13, 29));
  return Buffer.concat([decipher.update(payload.subarray(29)), decipher.final()]);
}
