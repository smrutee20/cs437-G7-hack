// Production startup configuration (SPEC.md §16). Fails closed, listing the
// offending variable names only: values (credentials, paths, client IDs) are
// never echoed. Runtime checks that need I/O (files, database roles, signer
// health, durable commits) run at startup in each server.
import { isAbsolute } from "node:path";
import { parseIsolatedOrigins, type IsolatedOrigins } from "./origins.js";

/** Settled institutional domain (SPEC.md §2). A different domain needs a reviewed specification change. */
export const INSTITUTION_DOMAIN = "iitgn.ac.in";
const DEVELOPMENT_TLDS = /\.(test|localhost|local|example|invalid|internal)$|^localhost$/;
const DIAGNOSTIC_FLAGS = /(^|\s)--(inspect|inspect-brk|inspect-port|inspect-publish-uid|cpu-prof|heap-prof|prof|report-on-signal|report-on-fatalerror|report-uncaught-exception|diagnostic-dir|trace-events-enabled|heapsnapshot-signal)\b/;
const FORBIDDEN_PREFIXES = ["FEEDBACK_DEMO_", "FEEDBACK_MIN_", "FEEDBACK_SKIP_", "FEEDBACK_DISABLE_", "FEEDBACK_ALLOW_", "FEEDBACK_RELAX"];
const FORBIDDEN_EXACT = ["FEEDBACK_ENABLE_SYNTHETIC_DEMO", "GOOGLE_SDK_NODE_LOGGING", "NODE_DEBUG", "NODE_V8_COVERAGE", "GAXIOS_DEBUG"];
const PORTAL_ONLY = ["FEEDBACK_KEY_DIRECTORY", "FEEDBACK_KEY_ENCRYPTION_KEY_FILE", "FEEDBACK_CURSOR_KEY_FILE", "FEEDBACK_JOURNAL_PATH",
  "FEEDBACK_SIGNER_URL", "FEEDBACK_SIGNER_TOKEN_FILE", "FEEDBACK_GOOGLE_CLIENT_ID", "FEEDBACK_GOOGLE_CLIENT_SECRET_FILE",
  "FEEDBACK_PORTAL_DB_URL", "FEEDBACK_ISSUER_DB_URL", "FEEDBACK_AUTH_DB_URL", "FEEDBACK_CLOSER_DB_URL", "FEEDBACK_RETENTION_DB_URL"];

type Common = { origins: IsolatedOrigins; tls: { certFile: string; keyFile: string }; listen: { host: string; port: number } };
export type PortalConfig = Common & {
  service: "portal";
  oidc: { clientId: string; clientSecretFile: string; redirectUri: string; domain: typeof INSTITUTION_DOMAIN };
  databases: Record<"portal" | "issuer" | "auth" | "closer" | "retention", string>;
  keyDirectory: string; keyEncryptionKeyFile: string; cursorKeyFile: string; journalPath: string;
  signer: { url: string; tokenFile: string };
};
export type RespondConfig = Common & { service: "respond"; databases: { respond: string } };
export type ProductionConfig = PortalConfig | RespondConfig;

export class ProductionConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`SETUP ERROR: production configuration refused: ${problems.join("; ")}`);
  }
}

export function loadProductionConfig(service: "portal", env: Record<string, string | undefined>): PortalConfig;
export function loadProductionConfig(service: "respond", env: Record<string, string | undefined>): RespondConfig;
export function loadProductionConfig(service: "portal" | "respond", env: Record<string, string | undefined>): ProductionConfig;
export function loadProductionConfig(service: "portal" | "respond", env: Record<string, string | undefined>): ProductionConfig {
  const problems: string[] = [];
  const value = (name: string) => {
    const raw = env[name];
    if (raw === undefined || raw === "") { problems.push(`${name} is required`); return ""; }
    return raw;
  };
  const absolute = (name: string) => {
    const path = value(name);
    if (path && !isAbsolute(path)) problems.push(`${name} must be an absolute path`);
    return path;
  };

  if (env.NODE_ENV !== "production") problems.push("NODE_ENV must be production");
  for (const name of Object.keys(env)) {
    if (env[name] === undefined) continue;
    if (FORBIDDEN_EXACT.includes(name) || FORBIDDEN_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      problems.push(`${name} is not permitted in production (demo authentication, relaxed policy or request-capturing diagnostics)`);
    }
  }
  if (env.FEEDBACK_INSTITUTION_DOMAIN !== undefined && env.FEEDBACK_INSTITUTION_DOMAIN !== INSTITUTION_DOMAIN) {
    problems.push("FEEDBACK_INSTITUTION_DOMAIN differs from the settled institutional domain; that needs a reviewed specification change");
  }
  if (env.NODE_OPTIONS && DIAGNOSTIC_FLAGS.test(env.NODE_OPTIONS)) problems.push("NODE_OPTIONS enables inspection, profiling or diagnostic reports");

  let origins: IsolatedOrigins | undefined;
  try {
    origins = parseIsolatedOrigins(value("FEEDBACK_PORTAL_ORIGIN"), value("FEEDBACK_RESPOND_ORIGIN"));
    for (const [name, origin] of [["FEEDBACK_PORTAL_ORIGIN", origins.portal], ["FEEDBACK_RESPOND_ORIGIN", origins.respond]] as const) {
      if (DEVELOPMENT_TLDS.test(origin.hostname)) problems.push(`${name} uses a development hostname`);
    }
  } catch (error) {
    if (env.FEEDBACK_PORTAL_ORIGIN && env.FEEDBACK_RESPOND_ORIGIN) {
      problems.push(`FEEDBACK_PORTAL_ORIGIN/FEEDBACK_RESPOND_ORIGIN: ${(error as Error).message.replace(/"[^"]*"/g, "the configured value")}`);
    }
  }

  const database = (name: string) => {
    const raw = value(name);
    if (!raw) return "";
    let url: URL;
    try { url = new URL(raw); } catch { problems.push(`${name} is not a database URL`); return ""; }
    if (!/^postgres(ql)?:$/.test(url.protocol) || !url.username) problems.push(`${name} must be a postgresql URL with a dedicated login`);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.hostname.startsWith("/");
    if (!loopback && url.searchParams.get("sslmode") !== "verify-full") problems.push(`${name} must use sslmode=verify-full off-host`);
    return raw;
  };
  const distinctRoles = (urls: Record<string, string>) => {
    const users = Object.values(urls).filter(Boolean).map((raw) => { try { return new URL(raw).username; } catch { return raw; } });
    if (new Set(users).size !== users.length) problems.push("each service database pool must use a distinct database role");
  };
  let port = 443;
  if (env.FEEDBACK_LISTEN_PORT !== undefined) {
    port = Number(env.FEEDBACK_LISTEN_PORT);
    if (!/^[1-9][0-9]{0,4}$/.test(env.FEEDBACK_LISTEN_PORT) || port > 65535) problems.push("FEEDBACK_LISTEN_PORT is invalid");
  }
  const common = {
    tls: { certFile: absolute("FEEDBACK_TLS_CERT_FILE"), keyFile: absolute("FEEDBACK_TLS_KEY_FILE") },
    listen: { host: env.FEEDBACK_LISTEN_HOST ?? "0.0.0.0", port },
  };

  if (service === "respond") {
    for (const name of PORTAL_ONLY) {
      if (env[name] !== undefined) problems.push(`${name} must not be configured for the response service`);
    }
    const databases = { respond: database("FEEDBACK_RESPOND_DB_URL") };
    if (problems.length || !origins) throw new ProductionConfigError(problems);
    return { service, origins, ...common, databases };
  }

  const clientId = value("FEEDBACK_GOOGLE_CLIENT_ID");
  if (clientId && !/^[A-Za-z0-9-]+\.apps\.googleusercontent\.com$/.test(clientId)) problems.push("FEEDBACK_GOOGLE_CLIENT_ID is not a Google OAuth client ID");
  if (env.FEEDBACK_RESPOND_DB_URL !== undefined) problems.push("FEEDBACK_RESPOND_DB_URL must not be configured for the portal service");
  const databases = {
    portal: database("FEEDBACK_PORTAL_DB_URL"), issuer: database("FEEDBACK_ISSUER_DB_URL"), auth: database("FEEDBACK_AUTH_DB_URL"),
    closer: database("FEEDBACK_CLOSER_DB_URL"), retention: database("FEEDBACK_RETENTION_DB_URL"),
  };
  distinctRoles(databases);
  const signerUrl = value("FEEDBACK_SIGNER_URL");
  if (signerUrl && !/^http:\/\/(127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}$/.test(signerUrl)) {
    problems.push("FEEDBACK_SIGNER_URL must be a loopback-only private signer endpoint");
  }
  const config: Omit<PortalConfig, "origins"> = {
    service, ...common, databases,
    oidc: { clientId, clientSecretFile: absolute("FEEDBACK_GOOGLE_CLIENT_SECRET_FILE"),
      redirectUri: origins ? `${origins.portal.origin}/api/v1/auth/callback` : "", domain: INSTITUTION_DOMAIN },
    keyDirectory: absolute("FEEDBACK_KEY_DIRECTORY"), keyEncryptionKeyFile: absolute("FEEDBACK_KEY_ENCRYPTION_KEY_FILE"),
    cursorKeyFile: absolute("FEEDBACK_CURSOR_KEY_FILE"), journalPath: absolute("FEEDBACK_JOURNAL_PATH"),
    signer: { url: signerUrl, tokenFile: absolute("FEEDBACK_SIGNER_TOKEN_FILE") },
  };
  if (problems.length || !origins) throw new ProductionConfigError(problems);
  return { ...config, origins };
}
