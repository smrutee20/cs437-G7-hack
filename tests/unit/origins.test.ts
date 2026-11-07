import { describe, expect, test } from "vitest";
import { parseIsolatedOrigins } from "../../packages/config/src/origins";

// Rules come from SPEC.md §6 (distinct HTTPS hostnames; different ports are not
// cookie isolation), §16 (fail closed on identical hostnames, HTTP, wildcards),
// and §17.15 (same-host/distinct-port must fail the isolation preflight).
describe("portal/response origin isolation preflight", () => {
  test("accepts two distinct HTTPS hostnames", () => {
    const origins = parseIsolatedOrigins("https://portal.feedback.test:4173", "https://respond.feedback.test:4174");
    expect(origins.portal.origin).toBe("https://portal.feedback.test:4173");
    expect(origins.respond.origin).toBe("https://respond.feedback.test:4174");
  });

  test("rejects the same hostname on different ports", () => {
    expect(() => parseIsolatedOrigins("https://portal.feedback.test:4173", "https://portal.feedback.test:4174"))
      .toThrow(/distinct hostnames/);
  });

  test("rejects hostnames that differ only by letter case", () => {
    expect(() => parseIsolatedOrigins("https://portal.feedback.test:4173", "https://PORTAL.feedback.test:4174"))
      .toThrow();
  });

  test("rejects a hostname nested under the other", () => {
    expect(() => parseIsolatedOrigins("https://feedback.test", "https://respond.feedback.test")).toThrow();
    expect(() => parseIsolatedOrigins("https://portal.feedback.test", "https://feedback.test")).toThrow();
  });

  test.each([
    ["plain HTTP", "http://respond.feedback.test:4174"],
    ["a wildcard", "https://*.feedback.test"],
    ["a path", "https://respond.feedback.test:4174/app"],
    ["a trailing slash", "https://respond.feedback.test:4174/"],
    ["credentials", "https://user@respond.feedback.test:4174"],
    ["a query", "https://respond.feedback.test:4174?x=1"],
    ["an IPv4 literal", "https://127.0.0.1:4174"],
    ["an IPv6 literal", "https://[::1]:4174"],
    ["an empty value", ""],
  ])("rejects a response origin with %s", (_label, respond) => {
    expect(() => parseIsolatedOrigins("https://portal.feedback.test:4173", respond)).toThrow();
  });
});
