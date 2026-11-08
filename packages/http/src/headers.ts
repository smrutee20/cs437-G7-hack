// Production browser headers (SPEC.md §8, §14). The CSP has no inline or eval
// exceptions. COOP stays `unsafe-none` only on the two pages whose opener link
// is the claim bridge (the response poll page and the portal bridge).
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self'", "font-src 'self'",
  "connect-src 'self'", "worker-src 'self'", "base-uri 'none'", "object-src 'none'", "frame-src 'none'",
  "frame-ancestors 'none'", "form-action 'self'",
].join("; ");

export const BASE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-DNS-Prefetch-Control": "off",
};

/** HSTS only once TLS and the exact hostname are in place (the production servers always serve HTTPS). */
export const HSTS = "max-age=31536000";

export type Opener = "bridge" | "isolated";
export function openerPolicy(opener: Opener): string {
  return opener === "bridge" ? "unsafe-none" : "same-origin";
}
