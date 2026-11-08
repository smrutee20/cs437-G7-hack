// Production portal entrypoint (SPEC.md §5, §14, §16). Every startup check fails
// closed before anything listens: secrets, key store, per-role database logins,
// durable commits, the recovery journal, signer health and the built bundle.
// No logger is configured anywhere in the request path.
import { fileURLToPath, pathToFileURL } from "node:url";
import { Pool, type PoolClient } from "pg";
import { loadProductionConfig, type PortalConfig } from "@iitgn-feedback/config/production";
import {
  applyRequestBudget, assertDatabaseRole, httpsServerFactory, loadBundle, parseKeyMaterial, readSecretFile, registerFrontend,
  type RUNTIME_ROLES,
} from "@iitgn-feedback/http";
import { createSessionStore } from "./auth.js";
import { closeExpiredPolls } from "./expiry.js";
import { createApp } from "./index.js";
import { assertJournalInSync } from "./journal.js";
import { checkedDirectory } from "./key-files.js";
import { runRetention } from "./operations.js";
import { sweepOrphanedKeys } from "./orphan-keys.js";
import { createSignerClient } from "./signer-client.js";

const DEFAULT_FRONTEND = fileURLToPath(new URL("../../../apps/portal/dist", import.meta.url));
const ROLE_FOR: Record<keyof PortalConfig["databases"], typeof RUNTIME_ROLES[number]> = {
  portal: "feedback_portal_admin", issuer: "feedback_issuer", auth: "feedback_auth",
  closer: "feedback_closer", retention: "feedback_retention",
};

export async function startPortalServer(config: PortalConfig, options: { frontendDirectory?: string; signerTimeoutMs?: number } = {}) {
  const secret = (path: string, name: string) => readSecretFile(path, name);
  const [cert, key, clientSecret, encryption, cursor, signerToken] = await Promise.all([
    secret(config.tls.certFile, "FEEDBACK_TLS_CERT_FILE"), secret(config.tls.keyFile, "FEEDBACK_TLS_KEY_FILE"),
    secret(config.oidc.clientSecretFile, "FEEDBACK_GOOGLE_CLIENT_SECRET_FILE"),
    secret(config.keyEncryptionKeyFile, "FEEDBACK_KEY_ENCRYPTION_KEY_FILE"), secret(config.cursorKeyFile, "FEEDBACK_CURSOR_KEY_FILE"),
    secret(config.signer.tokenFile, "FEEDBACK_SIGNER_TOKEN_FILE"),
  ]);
  const encryptionKey = parseKeyMaterial(encryption, "FEEDBACK_KEY_ENCRYPTION_KEY_FILE");
  const cursorKey = parseKeyMaterial(cursor, "FEEDBACK_CURSOR_KEY_FILE");
  try { await checkedDirectory(config.keyDirectory); }
  catch { throw new Error("SETUP ERROR: FEEDBACK_KEY_DIRECTORY must be a 0700 directory owned by this account"); }

  // Separate pools per database role; claims get the shortest statement bound (§9 preflight, §14 budget).
  const pools = Object.fromEntries(Object.entries(config.databases).map(([name, url]) => [name, new Pool({
    connectionString: url, max: name === "closer" || name === "retention" ? 1 : 8,
    statement_timeout: name === "issuer" ? 2000 : 5000, connectionTimeoutMillis: 2000, idleTimeoutMillis: 30_000,
  })])) as Record<keyof PortalConfig["databases"], Pool>;
  for (const pool of Object.values(pools)) pool.on("error", () => {}); // idle-client errors carry no request data; never logged
  const endPools = () => Promise.allSettled(Object.values(pools).map((pool) => pool.end()));
  const timers: NodeJS.Timeout[] = [];
  try {
    for (const [name, pool] of Object.entries(pools) as [keyof PortalConfig["databases"], Pool][]) {
      const client = await pool.connect();
      try { await assertDatabaseRole(client, ROLE_FOR[name], `FEEDBACK_${name.toUpperCase()}_DB_URL`); }
      finally { client.release(); }
    }
    const journalClient = await pools.portal.connect();
    try { await assertJournalInSync(journalClient, config.journalPath); } finally { journalClient.release(); }
    const signer = createSignerClient({ url: config.signer.url, token: signerToken.toString("utf8").trim(), timeoutMs: options.signerTimeoutMs ?? 2000 });
    if (!(await signer.healthy())) throw new Error("SETUP ERROR: the private native signer is not healthy");
    const bundle = await loadBundle(options.frontendDirectory ?? DEFAULT_FRONTEND, { production: true });

    const lease = (pool: Pool) => async () => {
      const client: PoolClient = await pool.connect();
      return { client, release: async () => client.release() };
    };
    const store = createSessionStore(lease(pools.auth));
    const app = createApp({
      origin: config.origins.portal.origin, keyDirectory: config.keyDirectory, encryptionKey, cursorKey,
      authenticate: store.authenticate, acquireClient: lease(pools.portal),
      issuer: { acquireClient: lease(pools.issuer), signer },
      auth: { store, acquireClient: lease(pools.auth), oidc: { clientId: config.oidc.clientId,
        clientSecret: clientSecret.toString("utf8").trim(), redirectUri: config.oidc.redirectUri, domain: config.oidc.domain } },
      journalPath: config.journalPath,
      serverFactory: httpsServerFactory({ cert, key }),
    });
    registerFrontend(app, bundle, [
      { path: "/", opener: "isolated" }, { path: "/signed-in", opener: "isolated" }, { path: "/claim-bridge", opener: "bridge" },
    ]);
    applyRequestBudget(app);

    // Background jobs on their own roles. Failures are counted, never logged with data.
    const job = (pool: Pool, everyMs: number, action: (client: PoolClient) => Promise<unknown>) => {
      let running = false;
      const run = async () => {
        if (running) return;
        running = true;
        const client = await pool.connect().catch(() => undefined);
        try { if (client) await action(client); } catch { /* retried on the next tick */ } finally { client?.release(); running = false; }
      };
      timers.push(setInterval(() => void run(), everyMs));
      return run;
    };
    await job(pools.closer, 60_000, (client) => closeExpiredPolls(client))();
    await job(pools.retention, 3_600_000, async (client) => {
      await runRetention({ client, journalPath: config.journalPath, keyDirectory: config.keyDirectory });
      await sweepOrphanedKeys(client, config.keyDirectory, new Date());
    })();
    job(pools.retention, 30_000, (client) => client.query("SELECT operations.expire_auth_state()"));

    await app.listen({ host: config.listen.host, port: config.listen.port });
    return {
      app,
      close: async () => { timers.forEach(clearInterval); await app.close(); await endPools(); },
    };
  } catch (cause) {
    timers.forEach(clearInterval);
    await endPools();
    throw cause;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const server = await startPortalServer(loadProductionConfig("portal", process.env),
      { frontendDirectory: process.env.FEEDBACK_FRONTEND_DIRECTORY });
    const stop = () => { void server.close().finally(() => process.exit(0)); };
    process.once("SIGTERM", stop); process.once("SIGINT", stop);
  } catch (cause) {
    // Our own SETUP ERROR messages name settings only; anything else stays generic.
    console.error(cause instanceof Error && cause.message.startsWith("SETUP ERROR") ? cause.message : "SETUP ERROR: portal startup failed");
    process.exit(1);
  }
}
