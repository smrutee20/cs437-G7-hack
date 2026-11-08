// Response-host ingress hygiene (SPEC.md §14): these headers are not required,
// used, forwarded to the submission application, or retained. Removing them
// here is defense in depth; the deployment ingress must strip them as well.
const EXACT = new Set([
  "cookie", "authorization", "proxy-authorization", "forwarded", "via", "x-real-ip", "true-client-ip",
  "fastly-client-ip", "x-client-ip", "x-cluster-client-ip", "x-azure-clientip", "x-azure-socketip",
  "x-appengine-user-ip", "x-original-forwarded-for", "user-agent", "traceparent", "tracestate", "baggage",
  "x-request-id", "x-correlation-id", "x-amzn-trace-id", "x-cloud-trace-context", "b3", "uber-trace-id",
  "x-datadog-trace-id", "x-datadog-parent-id", "x-goog-iap-jwt-assertion", "x-forwarded-user",
  "x-forwarded-email", "remote-user", "x-remote-user", "x-user", "x-email", "device-memory", "dpr",
  "viewport-width", "rtt", "downlink", "ect", "save-data",
]);
const PREFIXES = ["x-forwarded-", "sec-ch-", "x-b3-", "cf-", "x-ms-client-principal", "x-auth-request-", "x-amz-cf-", "x-vercel-"];

export function isStrippedIngressHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return EXACT.has(lower) || PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** Removes identity, client-address, fingerprinting and tracing headers in place. */
export function stripIngressHeaders(headers: Record<string, unknown>): void {
  for (const name of Object.keys(headers)) if (isStrippedIngressHeader(name)) delete headers[name];
}
