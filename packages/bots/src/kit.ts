// The bot toolkit (docs/architecture.md §11.1): everything a bot derives from structured data, never
// from prose and never from a hard-coded id. Roles come from `RulesInfo.rules` (the agent view of
// `CompiledRules`), caps from `rules.gateway`, `RoundInput` and the briefing's `budget`, travel
// times from `view_map(fromCity)`, own forces from `view_player` on itself.

import {
  RESOURCE_IDS,
  type AgentRules,
  type BuildingId,
  type GatewayRules,
  type Json,
  type JsonObject,
  type QueueId,
  type Res,
  type ResourceId,
  type RulesInfo,
  type ToolArgs,
  type ToolCall,
  type ToolName,
  type UnitCounts,
  type UnitId,
} from "@perfidia/protocol";
import type { CombatHints } from "./hints.ts";

export type BuildingRow = AgentRules["buildings"][number];
export type UnitRow = AgentRules["units"][number];
export type RecruitQueueRow = AgentRules["queues"]["recruit"][number];

/** Unit roles derived from unit stats (§11.1); any may be absent except the founder. */
export interface UnitRoles {
  /** Best defense per resource among land units (the founder excluded). */
  readonly defender: UnitId | null;
  /** Best attack per resource among land units (the founder excluded). */
  readonly attacker: UnitId | null;
  /** The unit that founds cities (`roles.settler`). */
  readonly founder: UnitId;
  /** Best capacity per resource among carriers (`capacity > 0`). */
  readonly carrier: UnitId | null;
  /** Best naval strength per resource (`naval > 0`); absent in rulesets without warships. */
  readonly navy: UnitId | null;
}

/** The rules as a bot reads them, with lookups. */
export interface Kit {
  /** Instance cache key: `<configHash prefix>:<players>`. */
  readonly key: string;
  readonly ref: string;
  readonly rules: AgentRules;
  readonly gateway: GatewayRules;
  readonly buildings: ReadonlyMap<BuildingId, BuildingRow>;
  readonly units: ReadonlyMap<UnitId, UnitRow>;
  readonly queues: ReadonlyMap<QueueId, RecruitQueueRow>;
  readonly roles: UnitRoles;
  readonly producers: Readonly<Record<ResourceId, BuildingId>>;
  readonly storage: BuildingId;
  readonly population: BuildingId;
  readonly wall: BuildingId | null;
  /** The effective config (`RulesInfo.config`): ruleset-shaped, read only through hint paths. */
  readonly config: JsonObject;
}

export const ZERO: Res = Object.freeze({ wood: 0, stone: 0, gold: 0 });

/** The cache key of a `rules` result (§11.1: rules are cached by `(configHash, players)`). */
export function rulesKey(info: RulesInfo): string {
  return `${info.configHash.slice(0, 16)}:${info.rules.players}`;
}

const total = (r: Res): number => r.wood + r.stone + r.gold;

/**
 * The unit maximising `stat / cost` among `rows` (canonical order breaks ties), compared with
 * integer cross-products; a cost of 0 counts as 1.
 */
function bestPerCost(rows: readonly UnitRow[], stat: (u: UnitRow) => number): UnitId | null {
  let best: UnitRow | null = null;
  for (const u of rows) {
    if (stat(u) <= 0) continue;
    if (best === null) {
      best = u;
      continue;
    }
    const lhs = stat(u) * Math.max(1, total(best.cost));
    const rhs = stat(best) * Math.max(1, total(u.cost));
    if (lhs > rhs) best = u;
  }
  return best === null ? null : best.id;
}

/** Builds the kit of a `rules` result. */
export function makeKit(info: RulesInfo): Kit {
  const rules = info.rules;
  const founder = rules.roles.settler;
  const land = rules.units.filter((u) => u.domain === "land" && u.id !== founder);
  const roles: UnitRoles = {
    defender: bestPerCost(land, (u) => u.defense),
    attacker: bestPerCost(land, (u) => u.attack),
    founder,
    carrier: bestPerCost(rules.units, (u) => u.capacity),
    navy: bestPerCost(rules.units, (u) => u.naval),
  };
  return {
    key: rulesKey(info),
    ref: info.ruleset,
    rules,
    gateway: rules.gateway,
    buildings: new Map(rules.buildings.map((b) => [b.id, b])),
    units: new Map(rules.units.map((u) => [u.id, u])),
    queues: new Map(rules.queues.recruit.map((q) => [q.id, q])),
    roles,
    producers: rules.roles.producers,
    storage: rules.roles.storage,
    population: rules.roles.population,
    wall: rules.roles.wall,
    config: info.config,
  };
}

/**
 * The value at `path` in the effective config: a safe integer, an object of them (e.g. `{a, b, c}`),
 * or null when the path is missing or holds anything else.
 */
export function configValue(kit: Kit, path: readonly string[]): Json | null {
  let v: Json = kit.config;
  for (const key of path) {
    if (v === null || typeof v !== "object" || Array.isArray(v) || !Object.hasOwn(v, key)) {
      return null;
    }
    v = v[key] ?? null;
  }
  return v;
}

/** The safe integer at `path` in the effective config, or null. */
export function configInt(kit: Kit, path: readonly string[] | undefined): number | null {
  if (path === undefined) return null;
  const v = configValue(kit, path);
  return typeof v === "number" && Number.isSafeInteger(v) ? v : null;
}

/**
 * The base land defense at `level` of the hinted building (`CombatHints.baseDefense`): `a·L² + b·L
 * + c` from the `{a, b, c}` at its `quad` path, else `n·L` from the integer at its `perLevel` path;
 * null when the hint is absent or its numbers are missing.
 */
export function baseDefenseAt(
  kit: Kit,
  hint: CombatHints["baseDefense"],
  level: number,
): number | null {
  if (hint === undefined) return null;
  if (hint.quad !== undefined) {
    const q = configValue(kit, hint.quad);
    if (q === null || typeof q !== "object" || Array.isArray(q)) return null;
    const { a, b, c } = q;
    if (typeof a !== "number" || typeof b !== "number" || typeof c !== "number") return null;
    const v = a * level * level + b * level + c;
    return Number.isSafeInteger(v) ? v : null;
  }
  const n = configInt(kit, hint.perLevel);
  if (n === null) return null;
  const v = n * level;
  return Number.isSafeInteger(v) ? v : null;
}

/** A number-valued record of a report's data (`buildings`), or empty. */
export function levelsInReport(data: Readonly<Record<string, unknown>>): Record<string, number> {
  const raw = data["buildings"];
  const out: Record<string, number> = {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) out[k] = v;
  }
  return out;
}

/** The stock a report's data shows (`stock`), or null. */
export function stockInReport(data: Readonly<Record<string, unknown>>): Res | null {
  const raw = data["stock"];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) out[k] = v;
  }
  if (RESOURCE_IDS.some((r) => out[r] === undefined)) return null;
  return res(out["wood"] ?? 0, out["stone"] ?? 0, out["gold"] ?? 0);
}

/**
 * Share (‰) of a target's stock assumed spent on defenders once it sees an attack coming: bots
 * spend most of their stock on a mix of units when they wake, about a third of it on defenders.
 */
export const REACTION_PM = 300;

/**
 * The defense a city can add once it sees an attack coming (every incoming attack wakes its owner,
 * who spends its stock on units): `REACTION_PM` of its stock in defenders, when its buildings can
 * train them.
 */
export function reactionDefense(
  kit: Kit,
  levels: Readonly<Record<string, number>>,
  stock: Res | null,
): number {
  const def = kit.roles.defender;
  const row = def === null ? undefined : kit.units.get(def);
  if (row === undefined || stock === null || !meets(row.requires, levels)) return 0;
  const q = kit.queues.get(row.queue);
  if (q !== undefined && (levels[q.building] ?? 0) < 1) return 0;
  const n = Math.min(row.maxPerOrder, timesAffordable(pmRes(stock, REACTION_PM), row.cost));
  return n * row.defense;
}

/** The battle numbers of the combat hints, read in the effective config (so overrides count). */
export interface CombatNumbers {
  readonly base: NonNullable<CombatHints["baseDefense"]>;
  /** Land defense bonus per wall level (‰); 0 when the hints name no wall bonus. */
  readonly wallPm: number;
  /** Morale lost per city of difference (‰); 0 (no morale) when the hints name none. */
  readonly moralePm: number;
  readonly moraleFloorPm: number;
}

/**
 * What the combat hints mean, for every bot that weighs battles: null when the base defense cannot
 * be resolved (no hints, or its numbers missing), and the bot falls back to its safety margins;
 * otherwise a wall bonus or morale the hints do not name counts as none (sandbox-1 has neither).
 */
export function combatNumbers(kit: Kit, h: CombatHints | undefined): CombatNumbers | null {
  const base = h?.baseDefense;
  if (h === undefined || base === undefined || baseDefenseAt(kit, base, 0) === null) return null;
  return {
    base,
    wallPm: configInt(kit, h.wallPmPerLevel) ?? 0,
    moralePm: configInt(kit, h.morale?.perCity) ?? 0,
    moraleFloorPm: configInt(kit, h.morale?.floor) ?? 1000,
  };
}

/** A typed tool call; the args are checked against the protocol schema by the caller's tests. */
export function call<T extends ToolName>(tool: T, args: ToolArgs<T>): ToolCall {
  return { tool, args };
}

// Resources.

export function res(wood: number, stone: number, gold: number): Res {
  return { wood, stone, gold };
}
export function resOfTriple(t: readonly number[]): Res {
  return res(t[0] ?? 0, t[1] ?? 0, t[2] ?? 0);
}
export function addRes(a: Res, b: Res): Res {
  return res(a.wood + b.wood, a.stone + b.stone, a.gold + b.gold);
}
/** `a − b`, floored at 0 per resource. */
export function subRes(a: Res, b: Res): Res {
  return res(
    Math.max(0, a.wood - b.wood),
    Math.max(0, a.stone - b.stone),
    Math.max(0, a.gold - b.gold),
  );
}
export function scaleRes(a: Res, n: number): Res {
  return res(a.wood * n, a.stone * n, a.gold * n);
}
/** `a × pm / 1000`, floored per resource. */
export function pmRes(a: Res, pm: number): Res {
  return res(
    Math.floor((a.wood * pm) / 1000),
    Math.floor((a.stone * pm) / 1000),
    Math.floor((a.gold * pm) / 1000),
  );
}
/** True when `have` covers `cost` for every resource. */
export function covers(have: Res, cost: Res): boolean {
  return have.wood >= cost.wood && have.stone >= cost.stone && have.gold >= cost.gold;
}
export function largest(r: Res): number {
  return Math.max(r.wood, r.stone, r.gold);
}
/** How many times `each` fits in `have` (a large number when `each` is free). */
export function timesAffordable(have: Res, each: Res): number {
  let n = 1_000_000;
  for (const r of RESOURCE_IDS) {
    if (each[r] > 0) n = Math.min(n, Math.floor(have[r] / each[r]));
  }
  return n;
}

/**
 * Seconds until `cost` is affordable from `stock` at `rate` per game hour, with storage `cap`:
 * 0 when affordable now, `null` when never (a resource above the cap, or missing with no income).
 */
export function etaAfford(stock: Res, rate: Res, cost: Res, cap: number): number | null {
  let eta = 0;
  for (const r of RESOURCE_IDS) {
    const need = cost[r] - stock[r];
    if (need <= 0) continue;
    if (cost[r] > cap || rate[r] <= 0) return null;
    eta = Math.max(eta, Math.floor((need * 3600 + rate[r] - 1) / rate[r]));
  }
  return eta;
}

// Buildings and requirements.

/** `requires` met by `levels` (a missing level is 0). */
export function meets(
  requires: Readonly<Record<string, number>>,
  levels: Readonly<Record<string, number>>,
): boolean {
  for (const [b, lvl] of Object.entries(requires)) if ((levels[b] ?? 0) < lvl) return false;
  return true;
}

/** The lowest storage level whose cap holds `amount`, or null when no level does. */
export function storageLevelFor(kit: Kit, amount: number): number | null {
  const caps = kit.rules.levels.storage;
  const max = kit.buildings.get(kit.storage)?.maxLevel ?? caps.length - 1;
  for (let lvl = 0; lvl <= max && lvl < caps.length; lvl += 1) {
    if ((caps[lvl] ?? 0) >= amount) return lvl;
  }
  return null;
}

// Units.

/** Σ count × stat over `units`; `land` restricts to land units. */
export function power(
  kit: Kit,
  units: Readonly<UnitCounts>,
  stat: "attack" | "defense" | "naval",
  land: boolean,
): number {
  let sum = 0;
  for (const [id, n] of Object.entries(units)) {
    const row = kit.units.get(id);
    if (row === undefined || (land && row.domain !== "land")) continue;
    sum += row[stat] * n;
  }
  return sum;
}

/** Σ pop of the land units of `units` (what carriers must hold across water, §6.4 of perfidia-1). */
export function landPop(kit: Kit, units: Readonly<UnitCounts>): number {
  let sum = 0;
  for (const [id, n] of Object.entries(units)) {
    const row = kit.units.get(id);
    if (row !== undefined && row.domain === "land") sum += row.pop * n;
  }
  return sum;
}

/** Σ carrier capacity of `units`. */
export function capacity(kit: Kit, units: Readonly<UnitCounts>): number {
  let sum = 0;
  for (const [id, n] of Object.entries(units)) sum += (kit.units.get(id)?.capacity ?? 0) * n;
  return sum;
}

/** `units` without zero or negative entries, keys in canonical unit order. */
export function cleanUnits(kit: Kit, units: Readonly<Record<string, number>>): UnitCounts {
  const out: UnitCounts = {};
  for (const row of kit.rules.units) {
    const n = units[row.id] ?? 0;
    if (n > 0) out[row.id] = n;
  }
  return out;
}

export function countOf(units: Readonly<Record<string, number>>, id: UnitId | null): number {
  return id === null ? 0 : (units[id] ?? 0);
}

/**
 * Unit counts found anywhere in a report's data: every object whose keys are all unit ids of the
 * rules and whose values are non-negative integers is added up. Meant for spy snapshots, which list
 * the units present by owner and role (disjoint groups, so the sum is the garrison). A battle
 * report lists both sides and several counts per stack, so its sum over-counts: `estimateDefense`
 * does not read battle reports this way.
 */
export function unitsInReport(kit: Kit, data: Json): UnitCounts {
  const sum: Record<string, number> = {};
  const visit = (v: Json, depth: number): void => {
    if (depth > 8 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1);
      return;
    }
    const counts: [string, number][] = [];
    for (const [k, n] of Object.entries(v)) {
      if (kit.units.has(k) && typeof n === "number" && Number.isSafeInteger(n) && n >= 0) {
        counts.push([k, n]);
      }
    }
    const entries = Object.entries(v);
    if (entries.length > 0 && counts.length === entries.length) {
      for (const [k, n] of counts) sum[k] = (sum[k] ?? 0) + n;
      return;
    }
    for (const [, x] of entries) visit(x, depth + 1);
  };
  visit(data, 0);
  return cleanUnits(kit, sum);
}

// Travel.

/**
 * The travel probes (`rules.travelProbes`, the columns of `view_map`) that time a movement: the
 * probes of kind `spy` for a spy; for a group, every probe that is not a spy (callers take the
 * slowest, which is conservative). Falls back to every probe.
 */
export function probeIndexes(kit: Kit, spy: boolean): readonly number[] {
  const probes = kit.rules.travelProbes;
  const spies = probes.flatMap((p, i) => (p.group.kind === "spy" ? [i] : []));
  if (spy && spies.length > 0) return spies;
  const groups = probes.flatMap((p, i) => (p.group.kind === "spy" ? [] : [i]));
  return groups.length > 0 ? groups : probes.map((_, i) => i);
}

/** A travel time from a per-probe row: the slowest of the chosen probes. */
export function pickTravel(kit: Kit, row: readonly number[], spy: boolean): number | null {
  let best: number | null = null;
  for (const i of probeIndexes(kit, spy)) {
    const s = row[i];
    if (s !== undefined && (best === null || s > best)) best = s;
  }
  return best;
}

// Time.

export const DAY = 86400;

export function dayOf(t: number): number {
  return Math.floor(t / DAY);
}

function two(n: number): string {
  return String(n).padStart(2, "0");
}

/** `"D{day} HH:MM"` (with `:SS` when not zero), as the gateway prints game times (§7.3). */
export function fmtTime(t: number): string {
  const day = Math.floor(t / DAY);
  const s = t - day * DAY;
  const hhmm = `D${day + 1} ${two(Math.floor(s / 3600))}:${two(Math.floor((s % 3600) / 60))}`;
  return s % 60 === 0 ? hhmm : `${hhmm}:${two(s % 60)}`;
}
