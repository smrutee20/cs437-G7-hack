// Local synthetic-development environment only. Production origins, TLS, and
// headers belong to the deployment configuration (SPEC.md §16).
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseIsolatedOrigins, type IsolatedOrigins } from "./origins.js";

export const DEFAULT_LOCAL_ORIGINS = {
  portal: "https://portal.feedback.test:4173",
  respond: "https://respond.feedback.test:4174",
} as const;

export type LocalApp = keyof IsolatedOrigins;

/** Reads FEEDBACK_PORTAL_ORIGIN / FEEDBACK_RESPOND_ORIGIN and runs the isolation preflight. */
export function localOrigins(env: Record<string, string | undefined> = process.env): IsolatedOrigins {
  return parseIsolatedOrigins(
    env.FEEDBACK_PORTAL_ORIGIN ?? DEFAULT_LOCAL_ORIGINS.portal,
    env.FEEDBACK_RESPOND_ORIGIN ?? DEFAULT_LOCAL_ORIGINS.respond,
  );
}

export function localTlsPaths(repoRoot: string): { ca: string; cert: string; key: string } {
  const paths = {
    ca: resolve(repoRoot, ".certs/dev-ca.crt"),
    cert: resolve(repoRoot, ".certs/dev-server.crt"),
    key: resolve(repoRoot, ".certs/dev-server.key"),
  };
  const missing = Object.values(paths).filter((path) => !existsSync(path));
  if (missing.length > 0) {
    throw new Error(
      `SETUP ERROR: local TLS material is missing (${missing.join(", ")}). Run scripts/create-dev-certs.sh. This is an environment problem, not a test result.`,
    );
  }
  return paths;
}

export function originPort(origin: URL): number {
  return origin.port === "" ? 443 : Number(origin.port);
}

/** Vite dev-server options for one app, bound to loopback on its own hostname. */
export function localDevServer(app: LocalApp, repoRoot: string) {
  const origin = localOrigins()[app];
  const tls = localTlsPaths(repoRoot);
  return {
    host: "127.0.0.1",
    port: originPort(origin),
    strictPort: true,
    allowedHosts: [origin.hostname],
    https: { key: readFileSync(tls.key), cert: readFileSync(tls.cert) },
  };
}
