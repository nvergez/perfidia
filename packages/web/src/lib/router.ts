import { useSyncExternalStore } from "react";
import { isPlayerId, type PlayerId } from "./ids.ts";

// A tiny router on the History API: `/` (the match list) and `/m/:id` (a match), with the query
// `?pair=pA,pB` (the feed's pair mode), `?reel=1` (start the key moments reel) and `?start=1`
// (open at the first second instead of the latest). Parsing is pure; `useRoute` follows
// `history.pushState` (through `navigate`) and the back and forward buttons.

const MATCH_ID = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;

export type Route =
  | { readonly page: "list" }
  | {
      readonly page: "match";
      readonly id: string;
      readonly pair: readonly [PlayerId, PlayerId] | null;
      readonly reel: boolean;
      readonly start: boolean;
    }
  | { readonly page: "not-found"; readonly path: string };

function decode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/** `pA,pB`: two distinct player ids, or null. */
export function parsePair(value: string | null): readonly [PlayerId, PlayerId] | null {
  if (value === null) return null;
  const parts = value.split(",");
  if (parts.length !== 2) return null;
  const [a, b] = parts;
  if (a === undefined || b === undefined || a === b) return null;
  return isPlayerId(a) && isPlayerId(b) ? [a, b] : null;
}

export function parseRoute(pathname: string, search: string): Route {
  if (pathname === "/" || pathname === "") return { page: "list" };
  const m = /^\/m\/([^/]+)\/?$/.exec(pathname);
  const id = m?.[1] === undefined ? null : decode(m[1]);
  if (id === null || !MATCH_ID.test(id)) return { page: "not-found", path: pathname };
  const q = new URLSearchParams(search);
  return {
    page: "match",
    id,
    pair: parsePair(q.get("pair")),
    reel: q.get("reel") === "1",
    start: q.get("start") === "1",
  };
}

export interface MatchHrefOptions {
  readonly pair?: readonly [PlayerId, PlayerId] | null;
  readonly reel?: boolean;
  readonly start?: boolean;
}

/** `/m/<id>` with its query. */
export function matchHref(id: string, o: MatchHrefOptions = {}): string {
  const q = new URLSearchParams();
  if (o.pair !== undefined && o.pair !== null) q.set("pair", `${o.pair[0]},${o.pair[1]}`);
  if (o.reel === true) q.set("reel", "1");
  if (o.start === true) q.set("start", "1");
  const query = q.toString().replaceAll("%2C", ",");
  return `/m/${encodeURIComponent(id)}${query === "" ? "" : `?${query}`}`;
}

export function routeHref(r: Route): string {
  if (r.page === "list") return "/";
  if (r.page === "not-found") return r.path;
  return matchHref(r.id, r);
}

// The History API ----------------------------------------------------------------------------------

const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

const locationKey = (): string => `${window.location.pathname}${window.location.search}`;

/** Goes to `href` (same origin) without a page load. */
export function navigate(href: string, o: { readonly replace?: boolean } = {}): void {
  if (href === locationKey()) return;
  if (o.replace === true) window.history.replaceState(null, "", href);
  else window.history.pushState(null, "", href);
  notify();
}

let cachedKey = "";
let cachedRoute: Route = { page: "list" };

function snapshot(): Route {
  const key = locationKey();
  if (key !== cachedKey) {
    cachedKey = key;
    cachedRoute = parseRoute(window.location.pathname, window.location.search);
  }
  return cachedRoute;
}

/** The current route; re-renders on navigation. */
export function useRoute(): Route {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
