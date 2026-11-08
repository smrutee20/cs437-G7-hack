// Production response entrypoint (SPEC.md §10, §14, §16). Serves only the
// anonymous form and its public API. It has no identity, key, signer or
// session configuration, strips identity/client/tracing headers before the
// application sees a request, never sets a cookie, and has no logger.
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FastifyInstance } from "fastify";
import { Pool, type PoolClient } from "pg";
import { isCanonicalUuidV4 } from "@iitgn-feedback/protocol";
import { loadProductionConfig, type RespondConfig } from "@iitgn-feedback/config/production";
import {
  applyRequestBudget, assertDatabaseRole, httpsServerFactory, loadBundle, readSecretFile, registerFrontend, stripIngressHeaders,
} from "@iitgn-feedback/http";
import { createApp } from "./index.js";

const DEFAULT_FRONTEND = fileURLToPath(new URL("../../../apps/respond/dist", import.meta.url));

export async function startRespondServer(config: RespondConfig, options: {
  frontendDirectory?: string;
  /** Test-only inspection hook, run before listening. */
  beforeListen?: (app: FastifyInstance) => void;
} = {}) {
  const [cert, key] = await Promise.all([readSecretFile(config.tls.certFile, "FEEDBACK_TLS_CERT_FILE"),
    readSecretFile(config.tls.keyFile, "FEEDBACK_TLS_KEY_FILE")]);
  const pool = new Pool({ connectionString: config.databases.respond, max: 8, statement_timeout: 5000,
    connectionTimeoutMillis: 2000, idleTimeoutMillis: 30_000 });
  pool.on("error", () => {});
  try {
    const client = await pool.connect();
    try { await assertDatabaseRole(client, "feedback_response_public", "FEEDBACK_RESPOND_DB_URL"); } finally { client.release(); }
    const bundle = await loadBundle(options.frontendDirectory ?? DEFAULT_FRONTEND, { production: true });
    const app = createApp({
      origin: config.origins.respond.origin,
      acquireClient: async () => {
        const leased: PoolClient = await pool.connect();
        return { client: leased, release: async () => leased.release() };
      },
      serverFactory: httpsServerFactory({ cert, key }, (request) => stripIngressHeaders(request.headers)),
    });
    registerFrontend(app, bundle, [
      { path: "/", opener: "isolated" },
      { path: "/p/:pollId", opener: "bridge", accept: (params) => isCanonicalUuidV4(params.pollId) },
    ]);
    // The response host never sets cookies, whatever any handler attempts.
    app.addHook("onSend", async (_request, reply, payload) => { reply.removeHeader("Set-Cookie"); return payload; });
    applyRequestBudget(app);
    options.beforeListen?.(app);
    await app.listen({ host: config.listen.host, port: config.listen.port });
    return { app, close: async () => { await app.close(); await pool.end(); } };
  } catch (cause) {
    await pool.end().catch(() => {});
    throw cause;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const server = await startRespondServer(loadProductionConfig("respond", process.env),
      { frontendDirectory: process.env.FEEDBACK_FRONTEND_DIRECTORY });
    const stop = () => { void server.close().finally(() => process.exit(0)); };
    process.once("SIGTERM", stop); process.once("SIGINT", stop);
  } catch (cause) {
    console.error(cause instanceof Error && cause.message.startsWith("SETUP ERROR") ? cause.message : "SETUP ERROR: response startup failed");
    process.exit(1);
  }
}
