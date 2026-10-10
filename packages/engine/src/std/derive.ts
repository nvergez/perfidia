// Derivations (docs/architecture.md §4.3, §5.4): pure functions of a `ReadCtx` that never write,
// not even to materialise. Views and validation use them; property P3 checks they leave the state
// byte-identical. Every derived value (rates, caps, pop, free slots, a player's cities) is computed
// here and never stored.

import {
  RESOURCE_IDS,
  compareIds,
  type BuildingId,
  type City,
  type CityId,
  type CompiledRules,
  type DeepReadonly,
  type GameTime,
  type IslandId,
  type PlayerId,
  type QueueId,
  type QueueItemId,
  type RecruitBatch,
  type Res,
  type TravelGroup,
  type UnitCounts,
  type UnitId,
  type Violation,
} from "@perfidia/protocol";
import { ceilDiv, floorDiv, mulDiv } from "@perfidia/engine/core";
import type { ReadCtx, Relation } from "@perfidia/engine/contracts";
import { defaultRelations } from "./diplomacy.ts";
import {
  addInto,
  at,
  fail,
  levelOf,
  must,
  readCity,
  readIsland,
  resOf,
  resTotal,
  unitTable,
  unitsPop,
  zeroRes,
} from "./util.ts";

type Rules = DeepReadonly<CompiledRules>;

/** The id of the build queue; recruit queues take their ids from `CompiledRules`. */
export const BUILD_QUEUE = "build";

/** Seconds per game hour: rates are per hour (§3.3). */
const HOUR = 3600;

/** The keys of a record in `compareIds` order (§6.5). */
export function sortedIds<T extends string>(rec: Readonly<Record<T, unknown>>): T[] {
  const isKey = (k: string): k is T => Object.hasOwn(rec, k);
  return Object.keys(rec).filter(isKey).toSorted(compareIds);
}

// Economy -----------------------------------------------------------------------------------------

/**
 * Stock growth per game second, in stored units (whole × `resourceScale`), of a rate per game hour.
 * Exact only when `rate × resourceScale` is a multiple of 3600 (true for every rate when the scale
 * is a multiple of 3600, as in every phase-1 ruleset); anything else would make accrual
 * path-dependent, so it throws.
 */
export function accrualPerSecond(rules: Rules, ratePerHour: number): number {
  const scaled = ratePerHour * rules.resourceScale;
  if (!Number.isSafeInteger(scaled) || scaled % HOUR !== 0) {
    fail(`rate ${ratePerHour}/h × resourceScale ${rules.resourceScale} is not a whole per second`);
  }
  return scaled / HOUR;
}

/** Storage cap of each resource, in whole units. */
export function storageCap(r: ReadCtx, city: CityId): number {
  const c = readCity(r.state, city);
  return at(r.rules.levels.storage, levelOf(c, r.rules.roles.storage), "levels.storage");
}

/** Population cap of the city. */
export function popCap(r: ReadCtx, city: CityId): number {
  const c = readCity(r.state, city);
  return at(r.rules.levels.population, levelOf(c, r.rules.roles.population), "levels.population");
}

/**
 * Production per game hour: `floor(production[level of the producer] × richness / 1000)`; zero for a
 * neutral city when the ruleset says neutral cities do not produce.
 */
export function rates(r: ReadCtx, city: CityId): Res {
  const c = readCity(r.state, city);
  if (c.owner === null && !r.rules.neutralProduction) return zeroRes();
  const richness = readIsland(r.state, c.island).richnessPm;
  return resOf((id) => {
    const level = levelOf(c, r.rules.roles.producers[id]);
    return mulDiv(at(r.rules.levels.production, level, "levels.production"), richness, 1000);
  });
}

/**
 * Stored stock (resource-seconds) at `t ≥ stockAt`: `min(cap × scale, S + perSecond × (t − stockAt))`
 * per resource. A stock already at or above the cap stays as it is: the cap only stops growth.
 */
export function stockSecondsAt(r: ReadCtx, city: CityId, t: GameTime): Res {
  const c = readCity(r.state, city);
  if (!Number.isSafeInteger(t) || t < c.stockAt) {
    fail(`stock of ${city} asked at ${t}, before its last materialisation at ${c.stockAt}`);
  }
  const dt = t - c.stockAt;
  const capS = storageCap(r, city) * r.rules.resourceScale;
  const rate = rates(r, city);
  return resOf((id) => {
    const s = c.stock[id];
    if (dt === 0 || s >= capS) return s;
    const grown = s + accrualPerSecond(r.rules, rate[id]) * dt;
    if (!Number.isSafeInteger(grown)) fail(`stock of ${city} overflows at ${t}`);
    return grown < capS ? grown : capS;
  });
}

/** Visible stock (whole units, `floor(S / scale)`) at `t` (default now). Never writes. */
export function stockAt(r: ReadCtx, city: CityId, t: GameTime = r.now): Res {
  const s = stockSecondsAt(r, city, t);
  return resOf((id) => floorDiv(s[id], r.rules.resourceScale));
}

/**
 * The earliest game time ≥ now at which the visible stock covers `cost`: for each short resource
 * `ceilDiv(cost × scale − S, perSecond)` seconds (§4.3). `null` when it never will: a cost above the
 * storage cap, or a shortfall in a resource that is not produced.
 */
export function affordableAt(r: ReadCtx, city: CityId, cost: Readonly<Res>): GameTime | null {
  const scale = r.rules.resourceScale;
  const s = stockSecondsAt(r, city, r.now);
  const cap = storageCap(r, city);
  const rate = rates(r, city);
  let wait = 0;
  for (const id of RESOURCE_IDS) {
    const need = cost[id] * scale;
    if (s[id] >= need) continue;
    if (cost[id] > cap) return null;
    const perSecond = accrualPerSecond(r.rules, rate[id]);
    if (perSecond === 0) return null;
    wait = Math.max(wait, ceilDiv(need - s[id], perSecond));
  }
  return r.now + wait;
}

/**
 * How many units of cost `unitCost` the visible stock pays for now. A cost of zero in every
 * resource is unbounded: `Number.MAX_SAFE_INTEGER` (callers take the minimum with other limits).
 */
export function maxAffordable(r: ReadCtx, city: CityId, costEach: Readonly<Res>): number {
  const stock = stockAt(r, city);
  let n = Number.MAX_SAFE_INTEGER;
  for (const id of RESOURCE_IDS) {
    if (costEach[id] > 0) n = Math.min(n, floorDiv(stock[id], costEach[id]));
  }
  return n;
}

/**
 * The `INSUFFICIENT_RESOURCES` violation for paying `cost` from `city` now, or null when the
 * visible stock covers it. Details follow §7.3: `need_r`, `have_r`, `rate_r` for every short
 * resource, and `availableAt` (`null` = never).
 */
export function insufficientResources(
  r: ReadCtx,
  city: CityId,
  cost: Readonly<Res>,
): Violation | null {
  const stock = stockAt(r, city);
  if (RESOURCE_IDS.every((id) => stock[id] >= cost[id])) return null;
  const rate = rates(r, city);
  const details: Violation["details"] = { city };
  for (const id of RESOURCE_IDS) {
    if (stock[id] >= cost[id]) continue;
    details[`need_${id}`] = cost[id];
    details[`have_${id}`] = stock[id];
    details[`rate_${id}`] = rate[id];
  }
  details["availableAt"] = affordableAt(r, city, cost);
  return { code: "INSUFFICIENT_RESOURCES", details };
}

// Units and population ----------------------------------------------------------------------------

/** Units of batch `b` delivered by trickle at `t` (0 with batch delivery: those arrive at its end). */
export function trickledAt(rules: Rules, b: DeepReadonly<RecruitBatch>, t: GameTime): number {
  if (rules.queues.delivery !== "trickle" || t < b.start) return 0;
  return Math.min(b.count, floorDiv(t - b.start, b.unitTime));
}

/**
 * The owner's units at home at `t` (default now), including trickled units completed by `t` that
 * are not materialised yet. Never writes; a fresh object.
 */
export function unitsAtHome(r: ReadCtx, city: CityId, t: GameTime = r.now): UnitCounts {
  const c = readCity(r.state, city);
  const out: UnitCounts = {};
  addInto(r.rules, out, c.units);
  for (const q of r.rules.queues.recruit) {
    for (const b of c.recruit[q.id] ?? []) {
      const extra = trickledAt(r.rules, b, t) - b.done;
      if (extra > 0) addInto(r.rules, out, { [b.unit]: extra });
    }
  }
  return out;
}

/**
 * Pop used by the city (§4.4): every unit homed there wherever it is (at home, stationed, moving)
 * plus the units still in its recruit queues.
 */
export function popUsed(r: ReadCtx, city: CityId): number {
  const c = readCity(r.state, city);
  let used = unitsPop(r.rules, c.units);
  for (const other of Object.values(r.state.cities)) {
    for (const g of other.stationed) if (g.home === city) used += unitsPop(r.rules, g.units);
  }
  for (const m of Object.values(r.state.movements)) {
    if (m.home === city) used += unitsPop(r.rules, m.units);
  }
  for (const q of r.rules.queues.recruit) {
    for (const b of c.recruit[q.id] ?? []) used += (b.count - b.done) * b.popEach;
  }
  return used;
}

/** Cities owned plus founding units owned: queued, at home, moving or stationed (§6.2). */
export function settlerK(r: ReadCtx, p: PlayerId): number {
  const settler = r.rules.roles.settler;
  let k = 0;
  for (const c of Object.values(r.state.cities)) {
    for (const g of c.stationed) if (g.owner === p) k += g.units[settler] ?? 0;
    if (c.owner !== p) continue;
    k += 1 + (c.units[settler] ?? 0);
    for (const q of r.rules.queues.recruit) {
      for (const b of c.recruit[q.id] ?? []) if (b.unit === settler) k += b.count - b.done;
    }
  }
  for (const m of Object.values(r.state.movements)) {
    if (m.owner === p) k += m.units[settler] ?? 0;
  }
  return k;
}

/**
 * The cost of one unit recruited in `city` now: the table cost, or `settlerCost[k]` (clamped to the
 * last entry) for the founding unit, with k = `settlerK` of the city's owner before this unit.
 */
export function unitCost(r: ReadCtx, city: CityId, unit: UnitId): Res {
  const table = unitTable(r.rules, unit);
  if (unit !== r.rules.roles.settler) return { ...table.cost };
  const owner = must(readCity(r.state, city).owner ?? undefined, `owner of ${city}`);
  const costs = r.rules.settlerCost;
  const k = settlerK(r, owner);
  const cost = must(costs[Math.min(k, costs.length - 1)], `settlerCost[${k}]`);
  return { ...cost };
}

// Map and movements -------------------------------------------------------------------------------

/** Travel time through the ruleset's `travelTime` hook; asserts a whole number of seconds ≥ 1. */
export function travel(r: ReadCtx, from: IslandId, to: IslandId, g: TravelGroup): number {
  const t = r.ruleset.hooks.travelTime(r, from, to, g);
  if (!Number.isSafeInteger(t) || t < 1) fail(`travelTime(${from}, ${to}) returned ${t}`);
  return t;
}

/** Free slot numbers of the island, ascending. */
export function freeSlots(r: ReadCtx, island: IslandId): number[] {
  const slots = readIsland(r.state, island).slots;
  const used = new Set<number>();
  for (const c of Object.values(r.state.cities)) if (c.island === island) used.add(c.slot);
  const free: number[] = [];
  for (let s = 0; s < slots; s += 1) if (!used.has(s)) free.push(s);
  return free;
}

/** Cities owned by `p`, in `compareIds` order. */
export function citiesOf(r: ReadCtx, p: PlayerId): CityId[] {
  return sortedIds(r.state.cities).filter((id) => r.state.cities[id]?.owner === p);
}

/** The lowest city number `p` owns, or null. */
export function fallbackCity(r: ReadCtx, p: PlayerId): CityId | null {
  return citiesOf(r, p)[0] ?? null;
}

/**
 * Cargo in flight from `origin` (whole units, all resources): its shipments and the returns of
 * its bounced shipments, both counted by home city until they arrive (§7.3 of perfidia-1).
 */
export function inFlightCargo(r: ReadCtx, origin: CityId): number {
  let n = 0;
  for (const m of Object.values(r.state.movements)) {
    if (m.home !== origin) continue;
    if (m.kind === "shipment" || (m.kind === "return" && m.back?.kind === "shipment")) {
      n += resTotal(m.cargo);
    }
  }
  return n;
}

/** Whether a `hold` group of a player other than `owner` is stationed in the city (§5.4). */
export function isHeldAgainst(r: ReadCtx, city: CityId, owner: PlayerId | null): boolean {
  const c = r.state.cities[city];
  return c !== undefined && c.stationed.some((g) => g.role === "hold" && g.owner !== owner);
}

// Relations ---------------------------------------------------------------------------------------

/** `hooks.relations` when the ruleset has one, else `defaultRelations`. */
export function relationsOf(r: ReadCtx, p: PlayerId): readonly Relation[] {
  return r.ruleset.hooks.relations?.(r, p) ?? defaultRelations(r, p);
}

/** The relation of `a` towards `b`, through `relationsOf(a)`. */
export function relation(r: ReadCtx, a: PlayerId, b: PlayerId): "self" | "ally" | "pact" | "none" {
  if (a === b) return "self";
  const rels = relationsOf(r, a).filter((x) => x.player === b);
  if (rels.some((x) => x.kind === "ally")) return "ally";
  if (rels.some((x) => x.kind === "pact")) return "pact";
  return "none";
}

// Queues ------------------------------------------------------------------------------------------

/** One queue item with its timing, as views show it (§4.2, §8.1). */
export type QueueEta =
  | {
      readonly kind: "build";
      readonly queue: typeof BUILD_QUEUE;
      readonly item: QueueItemId;
      readonly building: BuildingId;
      /** Shown target: the current level plus the item's position among queued items of that building. */
      readonly level: number;
      readonly start: GameTime;
      readonly end: GameTime;
    }
  | {
      readonly kind: "recruit";
      readonly queue: QueueId;
      readonly item: QueueItemId;
      readonly unit: UnitId;
      readonly count: number;
      /** Units delivered by now (trickle), materialised or not. */
      readonly done: number;
      /** Completion time of the next unit with trickle delivery; the batch end otherwise. */
      readonly nextAt: GameTime;
      readonly start: GameTime;
      readonly end: GameTime;
    };

/** Every queue item of the city: the build queue, then the recruit queues in rules order. */
export function queueEtas(r: ReadCtx, city: CityId): QueueEta[] {
  const c: DeepReadonly<City> = readCity(r.state, city);
  const out: QueueEta[] = [];
  const position: Record<BuildingId, number> = {};
  for (const item of c.build) {
    const pos = (position[item.building] ?? 0) + 1;
    position[item.building] = pos;
    out.push({
      kind: "build",
      queue: BUILD_QUEUE,
      item: item.id,
      building: item.building,
      level: levelOf(c, item.building) + pos,
      start: item.start,
      end: item.end,
    });
  }
  const trickle = r.rules.queues.delivery === "trickle";
  for (const q of r.rules.queues.recruit) {
    for (const b of c.recruit[q.id] ?? []) {
      const done = Math.max(b.done, trickledAt(r.rules, b, r.now));
      const nextAt = trickle && done < b.count ? b.start + (done + 1) * b.unitTime : b.end;
      out.push({
        kind: "recruit",
        queue: q.id,
        item: b.id,
        unit: b.unit,
        count: b.count,
        done,
        nextAt,
        start: b.start,
        end: b.end,
      });
    }
  }
  return out;
}
