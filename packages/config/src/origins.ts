import { isIP } from "node:net";

export interface IsolatedOrigins {
  portal: URL;
  respond: URL;
}

/**
 * Fail-closed preflight for the two browser origins (SPEC.md §6, §16, §17.15).
 * Cookies are not isolated by port (RFC 6265 §8.5), so the portal and response
 * apps must be served from distinct, non-nested HTTPS hostnames. Each value must
 * be an exact origin serialization: no path, slash, query, credentials, or wildcard.
 */
export function parseIsolatedOrigins(portal: string, respond: string): IsolatedOrigins {
  const portalUrl = parseOrigin("portal", portal);
  const respondUrl = parseOrigin("response", respond);
  const a = portalUrl.hostname;
  const b = respondUrl.hostname;
  if (a === b) {
    throw new Error(
      `Origin isolation preflight failed: portal and response origins must use distinct hostnames; both use "${a}". Different ports do not isolate cookies.`,
    );
  }
  if (a.endsWith(`.${b}`) || b.endsWith(`.${a}`)) {
    throw new Error(
      `Origin isolation preflight failed: hostnames "${a}" and "${b}" are nested; one could scope cookies to the other.`,
    );
  }
  return { portal: portalUrl, respond: respondUrl };
}

function parseOrigin(role: string, value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Origin isolation preflight failed: ${role} origin is not an absolute URL.`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`Origin isolation preflight failed: ${role} origin must use HTTPS.`);
  }
  if (url.origin !== value) {
    throw new Error(
      `Origin isolation preflight failed: ${role} origin must be an exact lowercase origin such as "https://host.example" with no path, trailing slash, query, or credentials.`,
    );
  }
  const host = url.hostname;
  if (host.includes("*") || isIP(host.replace(/^\[|\]$/g, "")) !== 0 || !host.includes(".")) {
    throw new Error(`Origin isolation preflight failed: ${role} origin must use a DNS hostname, not a wildcard or IP literal.`);
  }
  return url;
}
