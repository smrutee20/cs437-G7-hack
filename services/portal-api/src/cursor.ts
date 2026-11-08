import { createHmac, timingSafeEqual } from "node:crypto";
import { isCanonicalUuidV4 } from "@iitgn-feedback/protocol";

// The cursor is opaque and bound to the authenticated owner. Persist this
// independent key across restarts; never derive it from an OAuth/session key.
function mac(payload: string, key: Buffer): Buffer {
  return createHmac("sha256", key).update(payload, "ascii").digest();
}
export function makeCursor(owner: string, createdAt: string, id: string, key: Buffer): string {
  const payload = Buffer.from(JSON.stringify({ owner, createdAt, id }), "utf8").toString("base64url");
  return `${payload}.${mac(payload, key).toString("base64url")}`;
}
export function readCursor(cursor: string, owner: string, key: Buffer): { createdAt: string; id: string } {
  if (cursor.length > 512 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("invalid cursor");
  const [payload, signature] = cursor.split(".");
  const digest = Buffer.from(signature, "base64url");
  if (digest.length !== 32 || digest.toString("base64url") !== signature ||
      !timingSafeEqual(digest, mac(payload, key))) throw new Error("invalid cursor");
  const decoded = Buffer.from(payload, "base64url");
  if (decoded.toString("base64url") !== payload) throw new Error("invalid cursor");
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid cursor");
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== 3 || item.owner !== owner || !isCanonicalUuidV4(item.id) ||
      typeof item.createdAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(item.createdAt) ||
      !Number.isFinite(Date.parse(item.createdAt)) ||
      new Date(item.createdAt).toISOString().slice(0, 19) !== item.createdAt.slice(0, 19)) {
    throw new Error("invalid cursor");
  }
  return { createdAt: item.createdAt, id: item.id };
}
