import type { CachePolicy } from "../service/api.ts";

// Response headers (phase-3 design §6.4): the same security headers on every response, whichever
// adapter serves it, and a `Cache-Control` per route policy. No CORS (same origin only), no cookies.

export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
});

/** HSTS, sent only behind a TLS-terminating proxy (`PERFIDIA_SERVE_TRUST_PROXY`). */
export const HSTS = "max-age=31536000";

export function cacheControl(policy: CachePolicy): string {
  if (policy.kind === "no-store") return "no-store";
  if (policy.kind === "max-age") return `public, max-age=${policy.seconds}`;
  return "public, max-age=31536000, immutable";
}
