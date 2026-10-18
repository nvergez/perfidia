import type { ServeConfig } from "../config.ts";
import { apiError, type ApiResult } from "../service/api.ts";
import type { LiveHub } from "../service/live.ts";
import type { RateLimiter } from "./limits.ts";

// What both adapters check before routing (phase-3 design §3.4, §6.4): the client's IP (from the
// proxy header only behind Fly), the HTTP rate limit, GET/HEAD only, and, for the WebSocket
// upgrade, the `Origin` (the server's own, a configured one, or none for non-browser clients) and
// the socket caps.

/** The client IP: Fly's header when the proxy is trusted, else the socket's address. */
export function clientIp(req: Request, socketIp: string | null, config: ServeConfig): string {
  if (config.trustProxy === "fly") {
    const fly = req.headers.get("fly-client-ip");
    if (fly !== null && fly.length > 0 && fly.length <= 64) return fly;
  }
  return socketIp ?? "unknown";
}

/** A request refused before routing (method or rate), or null. */
export function gate(
  req: Request,
  ip: string,
  limiter: RateLimiter,
  now: number,
): ApiResult | null {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return apiError(
      405,
      "METHOD_NOT_ALLOWED",
      `${req.method} is not allowed: this API is read-only`,
      "use GET (or HEAD)",
      { allow: "GET, HEAD" },
    );
  }
  const wait = limiter.take(ip, now);
  if (wait > 0) {
    return apiError(
      429,
      "RATE_LIMITED",
      "too many requests from your address",
      `retry in ${wait} s`,
      { "retry-after": String(wait) },
    );
  }
  return null;
}

/** Whether a WebSocket upgrade's `Origin` is acceptable. */
export function originAllowed(req: Request, config: ServeConfig): boolean {
  const origin = req.headers.get("origin");
  if (origin === null) return true;
  if (config.origins.includes(origin)) return true;
  const host = req.headers.get("host");
  if (host === null) return false;
  return origin === `http://${host}` || origin === `https://${host}`;
}

/** Why a WebSocket upgrade is refused, or null. */
export function upgradeRefusal(
  req: Request,
  ip: string,
  config: ServeConfig,
  hub: LiveHub,
): ApiResult | null {
  if (!originAllowed(req, config)) {
    return apiError(
      403,
      "FOREIGN_ORIGIN",
      "this WebSocket accepts the site's own origin only",
      "open the spectator page from this server",
    );
  }
  if (!hub.allowUpgrade(ip)) {
    return apiError(
      429,
      "TOO_MANY_SOCKETS",
      `at most ${config.limits.socketsPerIp} sockets per address (and ${config.limits.maxSockets} in all)`,
      "close other tabs, or retry later",
      { "retry-after": "30" },
    );
  }
  return null;
}

export function notFoundRoute(path: string): ApiResult {
  return apiError(
    404,
    "NO_ROUTE",
    `no route ${path.slice(0, 200)}`,
    "the routes are listed in GET /api/openapi/json",
  );
}

export function upgradeRequired(): ApiResult {
  return apiError(
    426,
    "UPGRADE_REQUIRED",
    "/api/live is a WebSocket",
    "open it with a WebSocket client",
  );
}
