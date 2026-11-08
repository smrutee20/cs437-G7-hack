// SPEC.md §16: production startup fails closed. Errors name variables, never values.
import { describe, expect, test } from "vitest";
import { loadProductionConfig } from "../../packages/config/src/production";

const portalEnv = (): Record<string, string> => ({
  NODE_ENV: "production",
  FEEDBACK_PORTAL_ORIGIN: "https://portal.feedback.example.org",
  FEEDBACK_RESPOND_ORIGIN: "https://respond.feedback.example.org",
  FEEDBACK_GOOGLE_CLIENT_ID: "1234-abc.apps.googleusercontent.com",
  FEEDBACK_GOOGLE_CLIENT_SECRET_FILE: "/run/secrets/google-client-secret",
  FEEDBACK_PORTAL_DB_URL: "postgresql://feedback_portal:s3cret-portal@db.internal:5432/feedback?sslmode=verify-full",
  FEEDBACK_ISSUER_DB_URL: "postgresql://feedback_issuer_login:s3cret-issuer@db.internal:5432/feedback?sslmode=verify-full",
  FEEDBACK_AUTH_DB_URL: "postgresql://feedback_auth_login:s3cret-auth@db.internal:5432/feedback?sslmode=verify-full",
  FEEDBACK_CLOSER_DB_URL: "postgresql://feedback_closer_login:s3cret-closer@db.internal:5432/feedback?sslmode=verify-full",
  FEEDBACK_RETENTION_DB_URL: "postgresql://feedback_retention_login:s3cret-retention@db.internal:5432/feedback?sslmode=verify-full",
  FEEDBACK_KEY_DIRECTORY: "/srv/feedback/keys",
  FEEDBACK_KEY_ENCRYPTION_KEY_FILE: "/run/secrets/key-encryption-key",
  FEEDBACK_CURSOR_KEY_FILE: "/run/secrets/cursor-key",
  FEEDBACK_JOURNAL_PATH: "/srv/feedback-journal/journal.jsonl",
  FEEDBACK_SIGNER_URL: "http://127.0.0.1:5186",
  FEEDBACK_SIGNER_TOKEN_FILE: "/run/secrets/signer-token",
  FEEDBACK_TLS_CERT_FILE: "/run/secrets/portal.crt",
  FEEDBACK_TLS_KEY_FILE: "/run/secrets/portal.key",
  FEEDBACK_LISTEN_PORT: "8443",
});
const respondEnv = (): Record<string, string> => ({
  NODE_ENV: "production",
  FEEDBACK_PORTAL_ORIGIN: "https://portal.feedback.example.org",
  FEEDBACK_RESPOND_ORIGIN: "https://respond.feedback.example.org",
  FEEDBACK_RESPOND_DB_URL: "postgresql://feedback_respond:s3cret-respond@db.internal:5432/feedback?sslmode=verify-full",
  FEEDBACK_TLS_CERT_FILE: "/run/secrets/respond.crt",
  FEEDBACK_TLS_KEY_FILE: "/run/secrets/respond.key",
});
const refused = (service: "portal" | "respond", env: Record<string, string>, pattern: RegExp) => {
  let message = "";
  try { loadProductionConfig(service, env); } catch (error) { message = (error as Error).message; }
  expect(message).toMatch(pattern);
  expect(message).not.toMatch(/s3cret|abc\.apps|\/run\/secrets/);
};

describe("production configuration", () => {
  test("a complete portal configuration loads with fixed institutional verification and an exact callback", () => {
    const config = loadProductionConfig("portal", portalEnv());
    expect(config.service).toBe("portal");
    if (config.service !== "portal") return;
    expect(config.origins.portal.origin).toBe("https://portal.feedback.example.org");
    expect(config.oidc).toEqual({ clientId: "1234-abc.apps.googleusercontent.com", clientSecretFile: "/run/secrets/google-client-secret",
      redirectUri: "https://portal.feedback.example.org/api/v1/auth/callback", domain: "iitgn.ac.in" });
    expect(config.listen).toEqual({ host: "0.0.0.0", port: 8443 });
    expect(Object.keys(config.databases).sort()).toEqual(["auth", "closer", "issuer", "portal", "retention"]);
  });

  test("a complete response configuration loads without any identity, key or signer setting", () => {
    const config = loadProductionConfig("respond", respondEnv());
    expect(config.service).toBe("respond");
    expect(JSON.stringify(config)).not.toMatch(/KEY_DIRECTORY|signer|google/i);
  });

  test("origin isolation and hostnames fail closed", () => {
    refused("portal", { ...portalEnv(), FEEDBACK_RESPOND_ORIGIN: "https://portal.feedback.example.org:8443" }, /FEEDBACK_RESPOND_ORIGIN|distinct/);
    refused("portal", { ...portalEnv(), FEEDBACK_PORTAL_ORIGIN: "http://portal.feedback.example.org" }, /HTTPS/);
    refused("portal", { ...portalEnv(), FEEDBACK_PORTAL_ORIGIN: "https://*.feedback.example.org" }, /wildcard/);
    refused("portal", { ...portalEnv(), FEEDBACK_RESPOND_ORIGIN: "https://x.portal.feedback.example.org" }, /nested/);
    refused("respond", { ...respondEnv(), FEEDBACK_RESPOND_ORIGIN: "https://respond.feedback.test" }, /development hostname/);
    refused("portal", { ...portalEnv(), FEEDBACK_PORTAL_ORIGIN: "https://portal.localhost" }, /development hostname/);
  });

  test("demo authentication, relaxed policy and a different institution are refused", () => {
    refused("portal", { ...portalEnv(), FEEDBACK_ENABLE_SYNTHETIC_DEMO: "yes-synthetic-only" }, /FEEDBACK_ENABLE_SYNTHETIC_DEMO/);
    refused("portal", { ...portalEnv(), FEEDBACK_DEMO_API: "1" }, /FEEDBACK_DEMO_API/);
    refused("respond", { ...respondEnv(), FEEDBACK_MIN_RESPONSES: "1" }, /FEEDBACK_MIN_RESPONSES/);
    refused("portal", { ...portalEnv(), FEEDBACK_SKIP_HD_CHECK: "1" }, /FEEDBACK_SKIP_HD_CHECK/);
    refused("portal", { ...portalEnv(), FEEDBACK_INSTITUTION_DOMAIN: "example.edu" }, /FEEDBACK_INSTITUTION_DOMAIN/);
    expect(loadProductionConfig("portal", { ...portalEnv(), FEEDBACK_INSTITUTION_DOMAIN: "iitgn.ac.in" }).service).toBe("portal");
    refused("portal", { ...portalEnv(), FEEDBACK_GOOGLE_CLIENT_ID: "*.apps.googleusercontent.com" }, /FEEDBACK_GOOGLE_CLIENT_ID/);
  });

  test("diagnostics that could capture requests are refused", () => {
    refused("portal", { ...portalEnv(), GOOGLE_SDK_NODE_LOGGING: "*" }, /GOOGLE_SDK_NODE_LOGGING/);
    refused("respond", { ...respondEnv(), NODE_DEBUG: "http" }, /NODE_DEBUG/);
    for (const flag of ["--inspect", "--inspect-brk=0", "--cpu-prof", "--heap-prof", "--prof", "--report-on-signal"]) {
      refused("respond", { ...respondEnv(), NODE_OPTIONS: `--max-old-space-size=512 ${flag}` }, /NODE_OPTIONS/);
    }
  });

  test("development mode, missing settings and shared database roles are refused", () => {
    refused("portal", { ...portalEnv(), NODE_ENV: "development" }, /NODE_ENV/);
    const missing = portalEnv(); delete missing.FEEDBACK_JOURNAL_PATH; delete missing.FEEDBACK_SIGNER_TOKEN_FILE;
    refused("portal", missing, /FEEDBACK_JOURNAL_PATH.*FEEDBACK_SIGNER_TOKEN_FILE|FEEDBACK_SIGNER_TOKEN_FILE.*FEEDBACK_JOURNAL_PATH/s);
    refused("portal", { ...portalEnv(), FEEDBACK_ISSUER_DB_URL: portalEnv().FEEDBACK_PORTAL_DB_URL }, /distinct database role/);
    refused("portal", { ...portalEnv(), FEEDBACK_AUTH_DB_URL: "postgresql://feedback_auth_login:s3cret-auth@db.internal:5432/feedback" }, /sslmode=verify-full/);
    refused("portal", { ...portalEnv(), FEEDBACK_SIGNER_URL: "http://signer.internal:5186" }, /FEEDBACK_SIGNER_URL/);
    refused("portal", { ...portalEnv(), FEEDBACK_KEY_DIRECTORY: "keys" }, /FEEDBACK_KEY_DIRECTORY/);
    expect(loadProductionConfig("portal", { ...portalEnv(),
      FEEDBACK_AUTH_DB_URL: "postgresql://feedback_auth_login:s3cret-auth@127.0.0.1:5432/feedback" }).service).toBe("portal");
  });

  test("the response service refuses identity, key and signer settings in its environment", () => {
    for (const name of ["FEEDBACK_KEY_DIRECTORY", "FEEDBACK_PORTAL_DB_URL", "FEEDBACK_ISSUER_DB_URL", "FEEDBACK_AUTH_DB_URL",
      "FEEDBACK_GOOGLE_CLIENT_SECRET_FILE", "FEEDBACK_SIGNER_TOKEN_FILE", "FEEDBACK_KEY_ENCRYPTION_KEY_FILE"]) {
      refused("respond", { ...respondEnv(), [name]: portalEnv()[name] }, new RegExp(name));
    }
  });
});
