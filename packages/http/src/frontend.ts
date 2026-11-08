// Serves one built browser bundle with the production headers. Files are read
// once at startup; nothing user-specific appears in names, ETags or cache keys.
import { lstat, readdir, readFile } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { BASE_HEADERS, HSTS, openerPolicy, type Opener } from "./headers.js";

const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".woff2": "font/woff2",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
};
export type Bundle = { index: Buffer; assets: Map<string, { body: Buffer; type: string }> };

async function walk(root: string, directory: string, out: string[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("SETUP ERROR: frontend bundle contains a symbolic link");
    if (entry.isDirectory()) await walk(root, path, out);
    else if (entry.isFile()) out.push(relative(root, path).split(sep).join("/"));
  }
}

/** Loads `dist/`. With `production`, a bundle containing the synthetic demo login is refused. */
export async function loadBundle(directory: string, { production }: { production: boolean }): Promise<Bundle> {
  if (!(await lstat(directory)).isDirectory()) throw new Error("SETUP ERROR: frontend bundle missing");
  const files: string[] = [];
  await walk(directory, directory, files);
  const assets = new Map<string, { body: Buffer; type: string }>();
  let index: Buffer | undefined;
  for (const file of files) {
    const body = await readFile(join(directory, file));
    if (production && body.includes("__demo")) throw new Error("SETUP ERROR: production bundle contains demo authentication");
    if (file === "index.html") { index = body; continue; }
    const type = TYPES[extname(file)];
    if (!type) throw new Error(`SETUP ERROR: unexpected frontend file type ${extname(file)}`);
    assets.set(`/${file}`, { body, type });
  }
  if (!index) throw new Error("SETUP ERROR: frontend index.html missing");
  if (production && /<script(?![^>]*\bsrc=)[^>]*>|\son\w+=|<style/i.test(index.toString("utf8"))) {
    throw new Error("SETUP ERROR: production index.html contains inline script or style");
  }
  return { index, assets };
}

export function applyBrowserHeaders(reply: FastifyReply, opener: Opener): FastifyReply {
  for (const [name, value] of Object.entries(BASE_HEADERS)) reply.header(name, value);
  return reply.header("Strict-Transport-Security", HSTS).header("Cross-Origin-Opener-Policy", openerPolicy(opener));
}

export type Page = { path: string; opener: Opener; accept?: (params: Record<string, string>) => boolean };

/**
 * Registers the bundle: hashed assets (immutable cache), the app's HTML pages
 * (no-store; public routes), and an HTML 404 page for any other non-API path.
 */
export function registerFrontend(app: FastifyInstance, bundle: Bundle, pages: Page[]): void {
  app.addHook("onSend", async (_request, reply, payload) => {
    // Every response, API included, carries the security headers.
    if (!reply.hasHeader("Content-Security-Policy")) applyBrowserHeaders(reply, "isolated");
    if (!reply.hasHeader("Cache-Control")) reply.header("Cache-Control", "no-store");
    return payload;
  });
  const html = (reply: FastifyReply, status: number, opener: Opener) =>
    applyBrowserHeaders(reply, opener).code(status).header("Cache-Control", "no-store").type("text/html; charset=utf-8").send(bundle.index);
  app.get("/assets/*", { config: { public: true } }, async (request, reply) => {
    const asset = request.url.includes("?") ? undefined : bundle.assets.get(request.url);
    if (!asset) return html(reply, 404, "isolated");
    return applyBrowserHeaders(reply, "isolated").header("Cache-Control", "public, max-age=31536000, immutable").type(asset.type).send(asset.body);
  });
  for (const page of pages) {
    app.get<{ Params: Record<string, string> }>(page.path, { config: { public: true } }, async (request, reply) =>
      page.accept && !page.accept(request.params) ? html(reply, 404, "isolated") : html(reply, 200, page.opener));
  }
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/") || (request.method !== "GET" && request.method !== "HEAD")) {
      return reply.code(404).header("Cache-Control", "no-store").send({ error: { code: "not_found", message: "not found" } });
    }
    return html(reply, 404, "isolated");
  });
}
