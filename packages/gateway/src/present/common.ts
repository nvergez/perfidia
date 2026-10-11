import { fmtDuration, fmtTime, own as lookup } from "@perfidia/engine/core";
import type { ReadCtx } from "@perfidia/engine/contracts";
import { defaultVisibility } from "@perfidia/engine/std";
import { copyJson, copyObject, isJsonArray, setOwn, stripControl } from "@perfidia/gateway/seat";
import {
  RESOURCE_IDS,
  type City,
  type DeepReadonly,
  type DurationPair,
  type GameTime,
  type Json,
  type JsonObject,
  type MovementId,
  type PlayerId,
  type Res,
  type TimePair,
  type UnitCounts,
} from "@perfidia/protocol";

// Shared helpers of the presentation layer (docs/architecture.md §8.1): time pairs, the ruleset's
// visibility with `std.defaultVisibility` as the fallback, fresh JSON copies and locale-free text.
// Everything the presentation returns is built from scratch: no reference into the engine state or
// the gateway state ever reaches a view (§6.6).

/** A game time as agents see it: `[223320, "D3 14:02"]` (§7.3). */
export function timePair(t: GameTime): TimePair {
  return [t, fmtTime(t)];
}

/** A duration as agents see it: `[381480, "4d 9h58m"]` (§7.3). */
export function durationPair(s: number): DurationPair {
  return [s, fmtDuration(s)];
}

/** `D3 14:58:08 (in 56m8s)`, or just the time when it is not in the future. */
export function timeAndWait(t: GameTime, now: GameTime): string {
  return t > now ? `${fmtTime(t)} (in ${fmtDuration(t - now)})` : fmtTime(t);
}

/**
 * The ruleset's fog-of-war policy for one read context: each function of `hooks.visibility`, else
 * the `std` default (§8.1); `briefing` falls back to `publicMatch` (§8.2). Every object a hook
 * returns is copied, so a hook that hands out part of the state never makes a view alias it.
 */
export interface SeatVisibility {
  cityAccess(viewer: PlayerId, city: string): "full" | "public";
  movementAccess(viewer: PlayerId, m: MovementId): "own" | "full" | "incoming" | null;
  publicCity(viewer: PlayerId, city: string): JsonObject;
  publicPlayer(p: PlayerId): JsonObject;
  publicMatch(): JsonObject;
  briefing(viewer: PlayerId): JsonObject;
}

export function visibilityOf(r: ReadCtx): SeatVisibility {
  const h = r.ruleset.hooks.visibility;
  const d = defaultVisibility;
  const publicMatch = (): JsonObject =>
    h?.publicMatch === undefined ? d.publicMatch(r) : h.publicMatch(r);
  return {
    cityAccess: (viewer, city) => {
      if (!isCityKey(r, city)) return "public";
      return h?.cityAccess === undefined
        ? d.cityAccess(r, viewer, city)
        : h.cityAccess(r, viewer, city);
    },
    movementAccess: (viewer, m) =>
      h?.movementAccess === undefined
        ? d.movementAccess(r, viewer, m)
        : h.movementAccess(r, viewer, m),
    publicCity: (viewer, city) => {
      if (!isCityKey(r, city)) return {};
      return copyObject(
        h?.publicCity === undefined ? d.publicCity(r, viewer, city) : h.publicCity(r, viewer, city),
      );
    },
    publicPlayer: (p) =>
      copyObject(h?.publicPlayer === undefined ? d.publicPlayer(r, p) : h.publicPlayer(r, p)),
    publicMatch: () => copyObject(publicMatch()),
    briefing: (viewer) =>
      copyObject(h?.briefing === undefined ? publicMatch() : h.briefing(r, viewer)),
  };
}

function isCityKey(r: ReadCtx, id: string): id is City["id"] {
  return Object.hasOwn(r.state.cities, id);
}

/** `core.own` under the presentation's name: the own value of `key`, never a prototype member. */
export { lookup };

// The JSON copies and the control-character stripping are the seat module's (`seat/clean.ts`), so
// the archive summaries and every view strip player text alike.
export { copyJson, copyObject, isJsonArray, setOwn, stripControl };

/**
 * Any JSON-safe value (a validated config, a JSON Schema) as a fresh `Json`. Throws on anything
 * else: configs and schemas are plain data, so that would be a host bug, never player input.
 */
export function toJson(value: unknown, where: string): Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${where}: ${value} is not JSON`);
    return value;
  }
  if (Array.isArray(value)) return value.map((v: unknown, i) => toJson(v, `${where}[${i}]`));
  if (typeof value === "object") {
    const out: JsonObject = {};
    for (const [key, v] of Object.entries(value)) {
      if (v !== undefined) setOwn(out, key, toJson(v, `${where}.${key}`));
    }
    return out;
  }
  throw new TypeError(`${where}: a ${typeof value} is not JSON`);
}

/** `toJson` for a value that must be an object. */
export function toJsonObject(value: unknown, where: string): JsonObject {
  const json = toJson(value, where);
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    throw new TypeError(`${where}: expected a JSON object`);
  }
  return json;
}

/** Unit counts in the rules' canonical unit order, zero entries left out; a fresh object. */
export function orderedUnits(
  order: readonly { readonly id: string }[],
  units: DeepReadonly<UnitCounts>,
): UnitCounts {
  const out: UnitCounts = {};
  for (const { id } of order) {
    const n = lookup(units, id);
    if (n !== undefined && n > 0) out[id] = n;
  }
  // An id the rules do not define never occurs in a consistent state; it is kept, after the others.
  for (const id of Object.keys(units).toSorted(byCodeUnit)) {
    const n = lookup(units, id);
    if (!Object.hasOwn(out, id) && n !== undefined && n > 0) out[id] = n;
  }
  return out;
}

/** `[wood, stone, gold]`. */
export function resTriple(res: DeepReadonly<Res>): [number, number, number] {
  return [res.wood, res.stone, res.gold];
}

/** A fresh `Res`. */
export function resCopy(res: DeepReadonly<Res>): Res {
  return { wood: res.wood, stone: res.stone, gold: res.gold };
}

/** The resource ids, in canonical order. */
export const RESOURCES = RESOURCE_IDS;

/** The city when `seat` owns it, else `undefined`: explanations read the state only through this. */
export function ownCity(r: ReadCtx, seat: PlayerId, id: string): DeepReadonly<City> | undefined {
  const city = lookup(r.state.cities, id);
  return city !== undefined && city.owner === seat ? city : undefined;
}

/** Total order on strings by UTF-16 code unit (no locale, §6.5). */
export function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The first `n` UTF-16 code units of `s`, one fewer when the last one kept would be the first half
 * of a surrogate pair, so a cut never leaves a lone surrogate (an emoji is kept whole or dropped).
 */
export function cutText(s: string, n: number): string {
  if (s.length <= n) return s;
  const last = s.charCodeAt(n - 1);
  return s.slice(0, last >= 0xd800 && last <= 0xdbff ? n - 1 : n);
}

/** `["a"]` → `a`; `["a", "b"]` → `a and b`; `["a", "b", "c"]` → `a, b and c`. */
export function joinAnd(items: readonly string[]): string {
  return joinWith(items, "and");
}

/** `["a", "b", "c"]` → `a, b or c`. */
export function joinOr(items: readonly string[]): string {
  return joinWith(items, "or");
}

function joinWith(items: readonly string[], word: string): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} ${word} ${items.at(-1) ?? ""}`;
}
