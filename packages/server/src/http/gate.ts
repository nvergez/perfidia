import { isLoopback, type ServeConfig } from "../config.ts";
import { apiError, type ApiResult } from "../service/api.ts";
import type { LiveHub } from "../service/live.ts";
import type { RateLimiter } from "./limits.ts";
import { LIVE_PATH } from "./routes.ts";

// What both adapters check before routing (phase-3 design §3.4, §6.4): GET/HEAD only; a canonical
// path (no trailing slash, no empty segment: both adapters route exact paths only); a `Host` the
// server answers to (DNS rebinding: a page on another name that resolves to this server is refused;
// `/api/health` answers any host, for platform health checks); the HTTP rate limit per client; and,
// for the WebSocket upgrade, the `Origin` (one derived from the server's own host names, a
// configured one, or none for non-browser clients) and the socket caps. Limits are keyed by the
// client's address, an IPv6 address by its /64 (one subscriber's network), an IPv4-mapped IPv6
// address by its IPv4 address.

export const HEALTH_PATH = "/api/health";

/** The key of a client address for limits: IPv4 as is, IPv6 by its /64. */
export function ipKey(ip: string): string {
  let a = ip.trim().toLowerCase();
  const zone = a.indexOf("%");
  if (zone >= 0) a = a.slice(0, zone);
  if (a.startsWith("[") && a.endsWith("]")) a = a.slice(1, -1);
  if (!a.includes(":")) return a;
  const groups = ipv6Groups(a);
  if (groups === null) return a;
  // ::ffff:a.b.c.d (IPv4-mapped): the IPv4 address.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const hi = groups[6] ?? 0;
    const lo = groups[7] ?? 0;
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(":")}::/64`;
}

/** The 16-bit groups of one side of an IPv6 address's `::` (an IPv4 tail allowed), or null. */
function groupsOf(part: string): number[] | null {
  if (part === "") return [];
  const out: number[] = [];
  const pieces = part.split(":");
  for (const [i, p] of pieces.entries()) {
    if (i === pieces.length - 1 && p.includes(".")) {
      const v4 = p.split(".").map((x) => (/^[0-9]{1,3}$/.test(x) ? Number(x) : -1));
      if (v4.length !== 4 || v4.some((x) => x < 0 || x > 255)) return null;
      out.push(((v4[0] ?? 0) << 8) | (v4[1] ?? 0), ((v4[2] ?? 0) << 8) | (v4[3] ?? 0));
    } else if (/^[0-9a-f]{1,4}$/.test(p)) {
      out.push(Number.parseInt(p, 16));
    } else {
      return null;
    }
  }
  return out;
}

/** The eight 16-bit groups of an IPv6 address (an embedded IPv4 tail allowed), or null. */
function ipv6Groups(a: string): number[] | null {
  const halves = a.split("::");
  if (halves.length > 2) return null;
  const left = groupsOf(halves[0] ?? "");
  const right = halves.length === 2 ? groupsOf(halves[1] ?? "") : [];
  if (left === null || right === null) return null;
  const missing = 8 - left.length - right.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

/** The client's limits key: Fly's header when the proxy is trusted, else the socket's address. */
export function clientIp(req: Request, socketIp: string | null, config: ServeConfig): string {
  if (config.trustProxy === "fly") {
    const fly = req.headers.get("fly-client-ip");
    if (fly !== null && fly.length > 0 && fly.length <= 64) return ipKey(fly);
  }
  return socketIp === null ? "unknown" : ipKey(socketIp);
}

/** The `Host` values the server answers to, once it listens on `port`. */
export function allowedHosts(config: ServeConfig, port: number): ReadonlySet<string> {
  const out = new Set(config.hosts.map((h) => h.toLowerCase()));
  if (isLoopback(config.host)) {
    for (const h of ["127.0.0.1", "localhost", "[::1]"]) out.add(`${h}:${port}`);
  }
  return out;
}

/** A request refused before routing (method, path, host or rate), or null. */
export function gate(
  req: Request,
  pathname: string,
  ip: string,
  hosts: ReadonlySet<string>,
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
  if ((pathname.length > 1 && pathname.endsWith("/")) || pathname.includes("//")) {
    return notFoundRoute(pathname);
  }
  if (pathname !== HEALTH_PATH && !hosts.has((req.headers.get("host") ?? "").toLowerCase())) {
    return apiError(
      421,
      "WRONG_HOST",
      "this server does not answer to that host name",
      "open the spectator site by its own address",
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

/** Whether a WebSocket upgrade's `Origin` is acceptable (never derived from the request). */
export function originAllowed(
  req: Request,
  config: ServeConfig,
  hosts: ReadonlySet<string>,
): boolean {
  const origin = req.headers.get("origin");
  if (origin === null) return true;
  if (config.origins.includes(origin)) return true;
  const o = origin.toLowerCase();
  for (const h of hosts) if (o === `http://${h}` || o === `https://${h}`) return true;
  return false;
}

/** Why a WebSocket upgrade is refused, or null. */
export function upgradeRefusal(
  req: Request,
  ip: string,
  config: ServeConfig,
  hosts: ReadonlySet<string>,
  hub: LiveHub,
): ApiResult | null {
  if (!originAllowed(req, config, hosts)) {
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
    `${LIVE_PATH} is a WebSocket`,
    "open it with a WebSocket client",
  );
}
