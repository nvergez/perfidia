// Economy actions (docs/architecture.md §7.1; perfidia-1 §5.3, §6.2–6.3, generic parts): `build`,
// `recruit` and `cancel_queue`, data-driven by `CompiledRules`. Validation checks, in order, the
// most fundamental problem first: ownership, ids, levels, requirements, batch and queue limits,
// storage, population, then resources. `apply` enqueues through `std`, which recomputes the same
// numbers from the same state; a mismatch with the plan is an engine bug.

import type { ReadCtx } from "@perfidia/engine/contracts";
import {
  cancelFrom,
  enqueueBuild,
  enqueueRecruit,
  maxAffordable,
  popCap,
  popUsed,
  settlerK,
  unitCost,
} from "@perfidia/engine/std";
import {
  RESOURCE_IDS,
  type ActionOf,
  type BuildingId,
  type City,
  type CityId,
  type DeepReadonly,
  type GameTime,
  type QueueId,
  type QueueItemId,
  type Res,
  type UnitId,
  type Violation,
} from "@perfidia/protocol";
import {
  DomainError,
  exceedsStorage,
  handler,
  level,
  levelReachedAt,
  locateItem,
  lookup,
  ownCity,
  pair,
  reject,
  shortOf,
  type Verdict,
} from "./common.ts";

/** The time at which queued items of the population building lift the cap to `wanted`, or null. */
function popCapReachedAt(r: ReadCtx, city: DeepReadonly<City>, wanted: number): GameTime | null {
  const b = r.rules.roles.population;
  let reached = level(city, b);
  for (const item of city.build) {
    if (item.building !== b) continue;
    reached += 1;
    if ((r.rules.levels.population[reached] ?? 0) >= wanted) return item.end;
  }
  return null;
}

/**
 * The first requirement of `requires` (in the canonical building order) that `have(b)` does not
 * meet, as a `REQUIREMENT_MISSING` violation; null when every one is met.
 */
function missingRequirement(
  r: ReadCtx,
  city: DeepReadonly<City>,
  requires: Readonly<Partial<Record<BuildingId, number>>>,
  on: "projected" | "completed",
  what: Violation["details"],
): Violation | null {
  for (const b of r.rules.buildings) {
    const needed = requires[b.id];
    if (needed === undefined) continue;
    const queued = city.build.filter((x) => x.building === b.id).length;
    const have = level(city, b.id) + (on === "projected" ? queued : 0);
    if (have >= needed) continue;
    return {
      code: "REQUIREMENT_MISSING",
      details: {
        ...what,
        city: city.id,
        requires: b.id,
        need: needed,
        have,
        on,
        availableAt: on === "completed" ? levelReachedAt(city, b.id, needed) : null,
      },
    };
  }
  return null;
}

function scale(cost: Readonly<Res>, n: number): Res {
  return { wood: cost.wood * n, stone: cost.stone * n, gold: cost.gold * n };
}

function lastEnd(items: readonly { readonly end: GameTime }[], now: GameTime): GameTime {
  const last = items[items.length - 1];
  return last === undefined ? now : Math.max(now, last.end);
}

// build ------------------------------------------------------------------------------------------

export interface BuildPlan {
  readonly city: CityId;
  readonly building: BuildingId;
  /** Projected target at enqueue. */
  readonly level: number;
  readonly cost: Res;
  readonly start: GameTime;
  readonly end: GameTime;
}

/**
 * `build {city, building}`: "+1 level" at the projected target (completed + queued + 1), which must
 * be ≤ `maxLevel`; at most `queues.build.max` items; requirements on projected or completed levels
 * per `queues.build.requiresOn`; the cost of the target level is paid now; the duration is
 * `time[target][build-speed level]`, starting at `max(now, end of the previous item)`.
 */
export const build = handler<ActionOf<"build">, BuildPlan>({
  validate(r, seat, a): Verdict<BuildPlan> {
    const own = ownCity(r, seat, a.city);
    if (!own.ok) return own;
    const city = own.city;
    const table = r.rules.buildings.find((b) => b.id === a.building);
    if (table === undefined) {
      return reject("INVALID_ARGS", { building: a.building, reason: "unknown_building" });
    }
    const current = level(city, a.building);
    const target = current + city.build.filter((x) => x.building === a.building).length + 1;
    if (target > table.maxLevel) {
      return reject("MAX_LEVEL", {
        city: a.city,
        building: a.building,
        level: current,
        target,
        maxLevel: table.maxLevel,
      });
    }
    const max = r.rules.queues.build.max;
    const head = city.build[0];
    if (city.build.length >= max) {
      return reject("QUEUE_FULL", {
        city: a.city,
        queue: "build",
        max,
        availableAt: head === undefined ? null : head.end,
      });
    }
    const missing = missingRequirement(r, city, table.requires, r.rules.queues.build.requiresOn, {
      building: a.building,
    });
    if (missing !== null) return { ok: false, violation: missing };
    const cost = table.cost[target];
    if (cost === undefined) throw new DomainError(`no cost for ${a.building} ${target}`);
    const what = { building: a.building, level: target };
    const storage = exceedsStorage(r, city, cost, what);
    if (storage !== null) return { ok: false, violation: storage };
    const short = shortOf(r, a.city, cost, what);
    if (short !== null) return { ok: false, violation: short };
    const speed = r.rules.roles.buildSpeed;
    const duration = table.time[target]?.[speed === null ? 0 : level(city, speed)];
    if (duration === undefined) throw new DomainError(`no build time for ${a.building} ${target}`);
    const start = lastEnd(city.build, r.now);
    return {
      ok: true,
      plan: {
        city: a.city,
        building: a.building,
        level: target,
        cost: { ...cost },
        start,
        end: start + duration,
      },
    };
  },
  apply(ctx, _seat, plan) {
    const item = enqueueBuild(ctx, plan.city, plan.building);
    if (item.level !== plan.level || item.start !== plan.start || item.end !== plan.end) {
      throw new DomainError(
        `build ${plan.building} in ${plan.city}: planned level ${plan.level} ${plan.start}..${plan.end}, enqueued ${item.level} ${item.start}..${item.end}`,
      );
    }
    return {
      city: plan.city,
      item: item.id,
      building: item.building,
      level: item.level,
      start: pair(item.start),
      end: pair(item.end),
      cost: { ...item.cost },
    };
  },
});

// recruit ----------------------------------------------------------------------------------------

export interface RecruitPlan {
  readonly city: CityId;
  readonly unit: UnitId;
  readonly queue: QueueId;
  readonly count: number;
  readonly cost: Res;
  readonly start: GameTime;
  readonly end: GameTime;
}

/**
 * `recruit {city, unit, count}`: requirements on completed levels; `count ≤ min(maxPerOrder,
 * queue maxCount)`; at most `maxBatches` batches; the cost (the founding unit's by k, §6.2 of
 * perfidia-1) must fit the storage cap (`EXCEEDS_STORAGE` names the level needed) and be in stock;
 * the pop of the order must fit the population cap of the completed level. Per-unit time at the
 * completed level of the queue's building; the batch starts at `max(now, end of the previous one)`.
 */
export const recruit = handler<ActionOf<"recruit">, RecruitPlan>({
  validate(r, seat, a): Verdict<RecruitPlan> {
    const own = ownCity(r, seat, a.city);
    if (!own.ok) return own;
    const city = own.city;
    const table = r.rules.units.find((u) => u.id === a.unit);
    if (table === undefined) {
      return reject("INVALID_ARGS", { unit: a.unit, reason: "unknown_unit" });
    }
    const queue = r.rules.queues.recruit.find((q) => q.id === table.queue);
    if (queue === undefined) throw new DomainError(`${a.unit}: no recruit queue ${table.queue}`);
    const missing = missingRequirement(r, city, table.requires, "completed", { unit: a.unit });
    if (missing !== null) return { ok: false, violation: missing };
    const max = Math.min(table.maxPerOrder, queue.maxCount);
    if (a.count > max) {
      return reject("BATCH_LIMIT", { city: a.city, unit: a.unit, requested: a.count, max });
    }
    const batches = city.recruit[queue.id] ?? [];
    const head = batches[0];
    if (batches.length >= queue.maxBatches) {
      return reject("QUEUE_FULL", {
        city: a.city,
        queue: queue.id,
        max: queue.maxBatches,
        availableAt: head === undefined ? null : head.end,
      });
    }
    const cost = scale(unitCost(r, a.city, a.unit), a.count);
    const what: Violation["details"] = { unit: a.unit, count: a.count };
    if (a.unit === r.rules.roles.settler) what["k"] = settlerK(r, seat);
    const storage = exceedsStorage(r, city, cost, what);
    if (storage !== null) return { ok: false, violation: storage };
    const used = popUsed(r, a.city);
    const cap = popCap(r, a.city);
    const pop = a.count * table.pop;
    if (used + pop > cap) {
      return reject("INSUFFICIENT_POPULATION", {
        city: a.city,
        unit: a.unit,
        count: a.count,
        need: pop,
        used,
        cap,
        availableAt: popCapReachedAt(r, city, used + pop),
      });
    }
    const short = shortOf(r, a.city, cost, what);
    if (short !== null) return { ok: false, violation: short };
    const unitTime = table.time[level(city, queue.building)];
    if (unitTime === undefined) throw new DomainError(`no recruit time for ${a.unit}`);
    const start = lastEnd(batches, r.now);
    return {
      ok: true,
      plan: {
        city: a.city,
        unit: a.unit,
        queue: queue.id,
        count: a.count,
        cost,
        start,
        end: start + a.count * unitTime,
      },
    };
  },
  apply(ctx, _seat, plan) {
    const batch = enqueueRecruit(ctx, plan.city, plan.unit, plan.count);
    const cost = scale(batch.costEach, batch.count);
    if (
      batch.start !== plan.start ||
      batch.end !== plan.end ||
      RESOURCE_IDS.some((id) => cost[id] !== plan.cost[id])
    ) {
      throw new DomainError(
        `recruit ${plan.count} ${plan.unit} in ${plan.city}: planned ${plan.start}..${plan.end}, enqueued ${batch.start}..${batch.end}`,
      );
    }
    return {
      city: plan.city,
      item: batch.id,
      queue: plan.queue,
      unit: batch.unit,
      count: batch.count,
      start: pair(batch.start),
      end: pair(batch.end),
      cost,
    };
  },
});

/**
 * The largest count a `recruit` of `unit` in `city` could have now (the gateway's `"max"`, §7.4):
 * the minimum of what the stock pays for, the free pop under the cap (queued pop included), the
 * queue's `maxCount` and the unit's `maxPerOrder`; 0 when the queue is full. Requirements are not
 * considered: an order they block fails with `REQUIREMENT_MISSING` whatever its count. Never writes.
 */
export function recruitMax(r: ReadCtx, city: CityId, unit: UnitId): number {
  const c = lookup(r.state.cities, city);
  const table = r.rules.units.find((u) => u.id === unit);
  const queue =
    table === undefined ? undefined : r.rules.queues.recruit.find((q) => q.id === table.queue);
  if (c === undefined || c.owner === null || table === undefined || queue === undefined) return 0;
  if ((c.recruit[queue.id] ?? []).length >= queue.maxBatches) return 0;
  const free = Math.max(0, popCap(r, city) - popUsed(r, city));
  const byPop = table.pop === 0 ? Number.MAX_SAFE_INTEGER : Math.floor(free / table.pop);
  const affordable = maxAffordable(r, city, unitCost(r, city, unit));
  return Math.max(0, Math.min(affordable, byPop, queue.maxCount, table.maxPerOrder));
}

// cancel_queue -----------------------------------------------------------------------------------

export interface CancelPlan {
  readonly city: CityId;
  readonly item: QueueItemId;
  readonly queue: QueueId;
  readonly removed: QueueItemId[];
}

/**
 * `cancel_queue {city, item}`: a tail cancel (§5.3, §6.3 of perfidia-1) of `item` and every later
 * item of its queue, refunded per `queues.refund` and capped by storage (`std.cancelFrom`): the
 * result names what was credited (`refund`) and what the cap cut (`lost`). An item
 * in no queue (already completed, cancelled or never issued) is `QUEUE_ITEM`. Emits nothing, not
 * even `queue_empty`.
 */
export const cancelQueue = handler<ActionOf<"cancel_queue">, CancelPlan>({
  validate(r, seat, a): Verdict<CancelPlan> {
    const own = ownCity(r, seat, a.city);
    if (!own.ok) return own;
    const where = locateItem(r, own.city, a.item);
    if (where === null) {
      return reject("QUEUE_ITEM", {
        city: a.city,
        item: a.item,
        issued: a.item <= own.city.itemSeq,
      });
    }
    return {
      ok: true,
      plan: { city: a.city, item: a.item, queue: where.queue, removed: where.ids },
    };
  },
  apply(ctx, _seat, plan) {
    const { refund, lost } = cancelFrom(ctx, plan.city, plan.item);
    return { city: plan.city, queue: plan.queue, removed: [...plan.removed], refund, lost };
  },
});
