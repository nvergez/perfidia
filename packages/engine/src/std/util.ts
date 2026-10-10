// Internal helpers of std: lookups that fail loudly, resource and unit-count arithmetic, event
// emission. Every helper iterates resources and units in the canonical `CompiledRules` order
// (docs/architecture.md §6.5), never in object key order.

import {
  RESOURCE_IDS,
  type BuildingId,
  type BuildingTable,
  type City,
  type CityId,
  type CompiledRules,
  type DeepReadonly,
  type GameState,
  type Island,
  type IslandId,
  type JsonObject,
  type LedgerEntry,
  type Movement,
  type MovementId,
  type PlayerId,
  type Recipient,
  type Res,
  type ResourceId,
  type UnitCounts,
  type UnitId,
  type UnitTable,
} from "@perfidia/protocol";
import type { Ctx } from "@perfidia/engine/contracts";

type Rules = DeepReadonly<CompiledRules>;
type ReadState = DeepReadonly<GameState>;

/**
 * Thrown when a std primitive is used against its preconditions (a missing entity, a shortfall
 * that validation should have rejected, an impossible table lookup). The kernel reports any throw
 * inside a handler as an engine bug and aborts the match (§5.3).
 */
export class StdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StdError";
  }
}

export function fail(message: string): never {
  throw new StdError(message);
}

export function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) fail(`${what} does not exist`);
  return value;
}

export function readCity(state: ReadState, id: CityId): DeepReadonly<City> {
  return must(state.cities[id], `city ${id}`);
}

export function draftCity(ctx: Ctx, id: CityId): City {
  return must(ctx.state.cities[id], `city ${id}`);
}

export function readIsland(state: ReadState, id: IslandId): DeepReadonly<Island> {
  return must(state.islands[id], `island ${id}`);
}

export function readMovement(state: ReadState, id: MovementId): DeepReadonly<Movement> {
  return must(state.movements[id], `movement ${id}`);
}

export function draftMovement(ctx: Ctx, id: MovementId): Movement {
  return must(ctx.state.movements[id], `movement ${id}`);
}

/** The table of building `id`; throws for an id the ruleset does not define. */
export function buildingTable(rules: Rules, id: BuildingId): DeepReadonly<BuildingTable> {
  return must(
    rules.buildings.find((b) => b.id === id),
    `building ${id} in the compiled rules`,
  );
}

/** The table of unit `id`; throws for an id the ruleset does not define. */
export function unitTable(rules: Rules, id: UnitId): DeepReadonly<UnitTable> {
  return must(
    rules.units.find((u) => u.id === id),
    `unit ${id} in the compiled rules`,
  );
}

/** `table[index]`, or a StdError naming the table when the index is not covered. */
export function at(table: readonly number[], index: number, what: string): number {
  const value = table[index];
  if (value === undefined) fail(`${what} has no entry for index ${index}`);
  return value;
}

/** The completed level of building `b` in a city (0 when the record lacks it). */
export function levelOf(city: DeepReadonly<City>, b: BuildingId): number {
  return city.buildings[b] ?? 0;
}

// Resources ---------------------------------------------------------------------------------------

export function resOf(f: (id: ResourceId) => number): Res {
  return { wood: f("wood"), stone: f("stone"), gold: f("gold") };
}

export function zeroRes(): Res {
  return { wood: 0, stone: 0, gold: 0 };
}

export function resTotal(r: Readonly<Res>): number {
  return r.wood + r.stone + r.gold;
}

export function isZeroRes(r: Readonly<Res>): boolean {
  return r.wood === 0 && r.stone === 0 && r.gold === 0;
}

export function assertRes(r: Readonly<Res>, what: string): void {
  for (const id of RESOURCE_IDS) {
    const v = r[id];
    if (!Number.isSafeInteger(v) || v < 0)
      fail(`${what}: ${id} must be a safe integer ≥ 0, got ${v}`);
  }
}

// Unit counts -------------------------------------------------------------------------------------

function assertKnownUnits(rules: Rules, units: Readonly<UnitCounts>, what: string): void {
  for (const id of Object.keys(units)) {
    if (!rules.units.some((u) => u.id === id)) fail(`${what}: unknown unit ${id}`);
    const n = units[id];
    if (n === undefined || !Number.isSafeInteger(n) || n < 0) {
      fail(`${what}: count of ${id} must be a safe integer ≥ 0, got ${n}`);
    }
  }
}

/**
 * A fresh copy of `units` without zero entries, keys in the canonical unit order. Throws on an
 * unknown unit id or a count that is not a safe integer ≥ 0.
 */
export function cleanUnits(rules: Rules, units: Readonly<UnitCounts>, what = "units"): UnitCounts {
  assertKnownUnits(rules, units, what);
  const out: UnitCounts = {};
  for (const u of rules.units) {
    const n = units[u.id] ?? 0;
    if (n > 0) out[u.id] = n;
  }
  return out;
}

export function unitTotal(units: Readonly<UnitCounts>): number {
  let n = 0;
  for (const v of Object.values(units)) n += v ?? 0;
  return n;
}

export function hasUnits(units: Readonly<UnitCounts>): boolean {
  return Object.values(units).some((v) => (v ?? 0) > 0);
}

/** Σ pop of `units`. */
export function unitsPop(rules: Rules, units: Readonly<UnitCounts>): number {
  let pop = 0;
  for (const u of rules.units) pop += (units[u.id] ?? 0) * u.pop;
  return pop;
}

/** Adds `add` into `target` in place (canonical order; zero entries never created). */
export function addInto(rules: Rules, target: UnitCounts, add: Readonly<UnitCounts>): void {
  const clean = cleanUnits(rules, add);
  for (const u of rules.units) {
    const n = clean[u.id];
    if (n !== undefined) target[u.id] = (target[u.id] ?? 0) + n;
  }
}

/** Whether `have` holds at least `need` of every unit. */
export function covers(have: Readonly<UnitCounts>, need: Readonly<UnitCounts>): boolean {
  return Object.keys(need).every((id) => (have[id] ?? 0) >= (need[id] ?? 0));
}

/** Subtracts `sub` from `target` in place, deleting entries that reach 0; throws on a shortfall. */
export function takeFrom(
  rules: Rules,
  target: UnitCounts,
  sub: Readonly<UnitCounts>,
  what: string,
): void {
  const clean = cleanUnits(rules, sub, what);
  if (!covers(target, clean)) {
    fail(`${what}: needs ${JSON.stringify(clean)}, holds ${JSON.stringify(target)}`);
  }
  for (const u of rules.units) {
    const n = clean[u.id];
    if (n === undefined) continue;
    const left = (target[u.id] ?? 0) - n;
    if (left > 0) target[u.id] = left;
    else delete target[u.id];
  }
}

// Ledger and events -------------------------------------------------------------------------------

/** The ledger entry of `owner` (`null`: the neutral entry), created when missing. */
export function ledgerOf(ctx: Ctx, owner: PlayerId | null): LedgerEntry {
  const key = owner ?? "neutral";
  let entry = ctx.state.ledger[key];
  if (entry === undefined) {
    entry = { made: {}, gone: {} };
    ctx.state.ledger[key] = entry;
  }
  return entry;
}

/** Emits a non-public event, or a public one with `pub`. */
export function emitTo(
  ctx: Ctx,
  type: string,
  data: JsonObject,
  to: readonly Recipient[],
  pub = false,
): void {
  ctx.emit({ type, public: pub, to: [...to], data });
}

/** Whether an event with this seq is still queued. */
export function isQueued(ctx: Ctx, seq: number): boolean {
  return ctx.state.queue.some((e) => e.seq === seq);
}

/** Cancels the event `seq` when it is still queued (an arrival handler runs after its own pop). */
export function cancelIfQueued(ctx: Ctx, seq: number): void {
  if (isQueued(ctx, seq)) ctx.cancel(seq);
}
