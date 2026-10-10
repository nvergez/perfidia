// Shared helpers of the default handlers (docs/architecture.md §5.2, §7.3): verdicts, lookups that
// never touch prototype keys, ownership checks, agent-facing time pairs and the details of the
// violations several handlers share. Validation reads only the actor's own data and public data
// (fog-safe, §7.2), and never writes.

import { fmtTime } from "@perfidia/engine/core";
import type { ReadCtx } from "@perfidia/engine/contracts";
import {
  BUILD_QUEUE,
  insufficientResources,
  sortedIds,
  storageCap,
  unitsAtHome,
} from "@perfidia/engine/std";
import {
  RESOURCE_IDS,
  type BuildingId,
  type City,
  type CityId,
  type DeepReadonly,
  type GameTime,
  type PlayerId,
  type Res,
  type UnitCounts,
  type Violation,
} from "@perfidia/protocol";

/** What `validate` returns (§5.2). */
export type Verdict<P> =
  | { ok: true; plan: P; warnings?: Violation[] }
  | { ok: false; violation: Violation };

/** A rejection. */
export type Rejection = { ok: false; violation: Violation };

export function reject(code: string, details: Violation["details"]): Rejection {
  return { ok: false, violation: { code, details } };
}

/**
 * A broken precondition inside a handler: a plan that no longer matches the state, an event whose
 * entity is gone. The kernel turns any throw inside a handler into an `EngineBug` (§5.3).
 */
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainError";
  }
}

/** The own value of `key`, never a prototype member. */
export function lookup<V>(rec: Readonly<Record<string, V>>, key: string): V | undefined {
  return Object.hasOwn(rec, key) ? rec[key] : undefined;
}

/** Like `lookup`, but a missing entry is an engine bug (the plan or the event named it). */
export function need<V>(rec: Readonly<Record<string, V>>, key: string, what: string): V {
  const value = lookup(rec, key);
  if (value === undefined) throw new DomainError(`${what} ${key} does not exist`);
  return value;
}

/** A game time as agents see it: the integer and its text (§7.3). */
export function pair(t: GameTime): [GameTime, string] {
  return [t, fmtTime(t)];
}

/**
 * The seat's own city, or `UNKNOWN_ID` (no such city) / `NOT_OWNER` (cities and their owners are
 * public, so both answers are fog-safe).
 */
export function ownCity(
  r: ReadCtx,
  seat: PlayerId,
  id: CityId,
): Rejection | { ok: true; city: DeepReadonly<City> } {
  const city = lookup(r.state.cities, id);
  if (city === undefined) return reject("UNKNOWN_ID", { city: id });
  if (city.owner !== seat) return reject("NOT_OWNER", { city: id, owner: city.owner });
  return { ok: true, city };
}

/** The completed level of building `b` (0 when the record lacks it). */
export function level(city: DeepReadonly<City>, b: BuildingId): number {
  return city.buildings[b] ?? 0;
}

/**
 * The time at which the completed level of `b` reaches `wanted` through the city's queued build
 * items (each completion adds +1 to the current level), or null when the queue never gets there.
 */
export function levelReachedAt(
  city: DeepReadonly<City>,
  b: BuildingId,
  wanted: number,
): GameTime | null {
  let reached = level(city, b);
  for (const item of city.build) {
    if (item.building !== b) continue;
    reached += 1;
    if (reached >= wanted) return item.end;
  }
  return null;
}

/**
 * `EXCEEDS_STORAGE` when some resource of `cost` is above the city's storage cap, so it can never be
 * paid from this city as it is: names the storage building (`storage`), its level
 * (`storageLevel`) and cap, the lowest level whose cap holds the cost (`requiredLevel`, `null` when
 * none does) and every `need_<r>` above the cap.
 */
export function exceedsStorage(
  r: ReadCtx,
  city: DeepReadonly<City>,
  cost: Readonly<Res>,
  extra: Violation["details"] = {},
): Violation | null {
  const cap = storageCap(r, city.id);
  const over = RESOURCE_IDS.filter((id) => cost[id] > cap);
  if (over.length === 0) return null;
  const storage = r.rules.roles.storage;
  const current = level(city, storage);
  const table = r.rules.buildings.find((b) => b.id === storage);
  const maxLevel = table?.maxLevel ?? current;
  const highest = Math.max(...over.map((id) => cost[id]));
  let requiredLevel: number | null = null;
  for (let l = current + 1; l <= maxLevel; l += 1) {
    if ((r.rules.levels.storage[l] ?? 0) >= highest) {
      requiredLevel = l;
      break;
    }
  }
  const details: Violation["details"] = {
    ...extra,
    city: city.id,
    storage,
    storageLevel: current,
    cap,
    requiredLevel,
  };
  for (const id of over) details[`need_${id}`] = cost[id];
  return { code: "EXCEEDS_STORAGE", details };
}

/**
 * `INSUFFICIENT_RESOURCES` for paying `cost` from the city now (`std.insufficientResources`: `need_r`,
 * `have_r` and `rate_r` for every short resource, `availableAt`, `null` = never), with `extra` in its
 * details; null when the stock covers it.
 */
export function shortOf(
  r: ReadCtx,
  city: CityId,
  cost: Readonly<Res>,
  extra: Violation["details"] = {},
): Violation | null {
  const v = insufficientResources(r, city, cost);
  return v === null ? null : { code: v.code, details: { ...extra, ...v.details } };
}

/** The first unit id of `units` (in code-unit order) that the rules do not define. */
export function unknownUnit(r: ReadCtx, units: Readonly<UnitCounts>): string | null {
  const ids = Object.keys(units).toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return ids.find((id) => !r.rules.units.some((u) => u.id === id)) ?? null;
}

/** `units` with zero entries dropped, keys in the canonical unit order of the rules. */
export function canonicalUnits(r: ReadCtx, units: Readonly<UnitCounts>): UnitCounts {
  const out: UnitCounts = {};
  for (const u of r.rules.units) {
    const n = units[u.id] ?? 0;
    if (n > 0) out[u.id] = n;
  }
  return out;
}

/**
 * `INSUFFICIENT_UNITS` for the first unit (canonical order) of `units` that the seat does not have
 * at home in `city` now (trickled recruits included): `unit`, `requested`, `home` (the count at
 * home) and, when some are away, `backAt`, the earliest arrival of an own return homed there that
 * carries that unit (`null` when none is on its way home). Null when every unit is at home.
 */
export function unitShortage(
  r: ReadCtx,
  city: DeepReadonly<City>,
  units: Readonly<UnitCounts>,
): Violation | null {
  const home = unitsAtHome(r, city.id);
  for (const u of r.rules.units) {
    const requested = units[u.id] ?? 0;
    const have = home[u.id] ?? 0;
    if (requested <= have) continue;
    const details: Violation["details"] = { city: city.id, unit: u.id, requested, home: have };
    let away = false;
    let backAt: GameTime | null = null;
    for (const id of sortedIds(r.state.movements)) {
      const m = r.state.movements[id];
      if (m === undefined || m.home !== city.id || m.owner !== city.owner) continue;
      if ((m.units[u.id] ?? 0) === 0) continue;
      away = true;
      if (m.kind === "return" && (backAt === null || m.arriveAt < backAt)) backAt = m.arriveAt;
    }
    for (const c of sortedIds(r.state.cities)) {
      for (const g of r.state.cities[c]?.stationed ?? []) {
        if (g.home === city.id && g.owner === city.owner && (g.units[u.id] ?? 0) > 0) away = true;
      }
    }
    if (away) details["backAt"] = backAt;
    return { code: "INSUFFICIENT_UNITS", details };
  }
  return null;
}

/** The queue that holds item `item` of the city, and its index there; null when none does. */
export function locateItem(
  r: ReadCtx,
  city: DeepReadonly<City>,
  item: number,
): { queue: string; index: number; ids: number[] } | null {
  const b = city.build.findIndex((x) => x.id === item);
  if (b >= 0) return { queue: BUILD_QUEUE, index: b, ids: city.build.slice(b).map((x) => x.id) };
  for (const q of r.rules.queues.recruit) {
    const batches = city.recruit[q.id] ?? [];
    const i = batches.findIndex((x) => x.id === item);
    if (i >= 0) return { queue: q.id, index: i, ids: batches.slice(i).map((x) => x.id) };
  }
  return null;
}
