// HTTPS server factory with the SPEC.md §14 request bounds: 8 KiB of headers
// (Node answers 431), a 2 KiB URI (414), five seconds to receive a request,
// and a ten-second application budget enforced by `applyRequestBudget`.
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import type { FastifyInstance, FastifyServerFactory } from "fastify";

export const MAX_HEADER_BYTES = 8 * 1024;
export const MAX_URI_BYTES = 2 * 1024;
export const RECEIVE_TIMEOUT_MS = 5_000;
export const REQUEST_BUDGET_MS = 10_000;

export function httpsServerFactory(tls: { cert: Buffer; key: Buffer }, onRequest?: (request: IncomingMessage) => void): FastifyServerFactory {
  return (handler) => {
    const server: Server = createServer({
      cert: tls.cert, key: tls.key, minVersion: "TLSv1.2", maxHeaderSize: MAX_HEADER_BYTES,
      requestTimeout: RECEIVE_TIMEOUT_MS, headersTimeout: RECEIVE_TIMEOUT_MS, keepAliveTimeout: 5_000,
    }, (request: IncomingMessage, response: ServerResponse) => {
      if (Buffer.byteLength(request.url ?? "", "utf8") > MAX_URI_BYTES) {
        response.writeHead(414, { "Content-Type": "application/json", "Cache-Control": "no-store", Connection: "close" });
        response.end('{"error":{"code":"invalid_request","message":"invalid request"}}');
        return;
      }
      onRequest?.(request);
      handler(request, response);
    });
    return server;
  };
}

/** Answers 503 temporarily_unavailable if a handler has not replied within the budget; the outcome is then uncertain. */
export function applyRequestBudget(app: FastifyInstance, budgetMs = REQUEST_BUDGET_MS): void {
  const timers = new WeakMap<object, NodeJS.Timeout>();
  app.addHook("onRequest", async (request, reply) => {
    timers.set(request, setTimeout(() => {
      if (!reply.sent) void reply.code(503).header("Cache-Control", "no-store")
        .send({ error: { code: "temporarily_unavailable", message: "temporarily unavailable" } });
    }, budgetMs));
  });
  app.addHook("onResponse", async (request) => { clearTimeout(timers.get(request)); });
}
