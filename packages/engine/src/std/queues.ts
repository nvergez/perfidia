// Build and recruit queues (docs/architecture.md §4.2, §5.4; perfidia-1 §5.3, §6.3). Items run
// strictly one after another; each has its own completion event (`build_done` / `recruit_done`,
// ref = the city id, seq = the item's seq). Cost, pop and duration are pinned at enqueue.
//
// `queue_empty` is emitted only by a completion that empties its queue. Cancels, removals,
// reflows and clears never emit it: an owner's own cancel needs no wake, and a siege or conquest
// clearing the queues must not spend the victim's own wake budget (§8.5).

import {
  RESOURCE_IDS,
  type BuildItem,
  type BuildingId,
  type City,
  type CityId,
  type QueueId,
  type QueueItemId,
  type RecruitBatch,
  type Recipient,
  type Res,
  type UnitId,
} from "@perfidia/protocol";
import { assertSafeInt, floorDiv } from "@perfidia/engine/core";
import type { Ctx } from "@perfidia/engine/contracts";
import { BUILD_QUEUE, unitCost } from "./derive.ts";
import { addCapped, materialize, setLevel, spend } from "./stock.ts";
import { spawnUnits } from "./units.ts";
import {
  at,
  buildingTable,
  cancelIfQueued,
  draftCity,
  emitTo,
  fail,
  levelOf,
  must,
  resOf,
  unitTable,
  zeroRes,
} from "./util.ts";

function owner(c: City): Recipient[] {
  return c.owner === null ? [] : [{ p: c.owner, as: "self" }];
}

function recruitQueue(c: City, queue: QueueId): RecruitBatch[] {
  return must(c.recruit[queue], `recruit queue ${queue} of ${c.id}`);
}

function lastEnd(items: readonly { end: number }[], now: number): number {
  const last = items[items.length - 1];
  return last === undefined ? now : Math.max(now, last.end);
}

/**
 * Enqueues "+1 level of `b`" (validated by the caller): projected target = completed level +
 * queued items of `b` + 1, which sets the cost (paid now) and the duration (at the completed
 * build-speed level). Starts at `max(now, end of the previous item)`. Returns the stored item.
 */
export function enqueueBuild(ctx: Ctx, city: CityId, b: BuildingId): BuildItem {
  const c = draftCity(ctx, city);
  const table = buildingTable(ctx.rules, b);
  const level = levelOf(c, b) + c.build.filter((x) => x.building === b).length + 1;
  if (level > table.maxLevel) fail(`${b} ${level} is above max level ${table.maxLevel}`);
  const speed = ctx.rules.roles.buildSpeed;
  const row = must(table.time[level], `time table of ${b} for level ${level}`);
  const duration = at(row, speed === null ? 0 : levelOf(c, speed), `time of ${b} ${level}`);
  const cost = { ...must(table.cost[level], `cost of ${b} ${level}`) };
  spend(ctx, city, cost);
  const start = lastEnd(c.build, ctx.now);
  const end = start + duration;
  const id = ctx.nextItem(city);
  const seq = ctx.schedule("build_done", end, city);
  const item: BuildItem = { id, building: b, level, cost, start, end, seq };
  c.build.push(item);
  return item;
}

/**
 * Enqueues a batch of `count` units (validated by the caller): cost per unit from `unitCost`
 * (founding units by k), all paid now; pop pinned per unit; unit time at the completed level of the
 * queue's building. Starts at `max(now, end of the previous batch)`. Returns the stored batch.
 */
export function enqueueRecruit(ctx: Ctx, city: CityId, unit: UnitId, count: number): RecruitBatch {
  assertSafeInt(count, "recruit count");
  if (count < 1) fail(`recruit count must be ≥ 1, got ${count}`);
  const c = draftCity(ctx, city);
  const table = unitTable(ctx.rules, unit);
  const queueDef = must(
    ctx.rules.queues.recruit.find((q) => q.id === table.queue),
    `recruit queue ${table.queue}`,
  );
  const unitTime = at(table.time, levelOf(c, queueDef.building), `time of ${unit}`);
  const costEach = unitCost(ctx.read(), city, unit);
  spend(
    ctx,
    city,
    resOf((id) => assertSafeInt(costEach[id] * count, "recruit cost")),
  );
  const batches = recruitQueue(c, queueDef.id);
  const start = lastEnd(batches, ctx.now);
  const end = start + count * unitTime;
  const id = ctx.nextItem(city);
  const seq = ctx.schedule("recruit_done", end, city);
  const batch: RecruitBatch = {
    id,
    unit,
    count,
    done: 0,
    unitTime,
    costEach,
    popEach: table.pop,
    start,
    end,
    seq,
  };
  batches.push(batch);
  return batch;
}

/**
 * Completes build item `item` (its event fired): +1 on the building's **current** level, capped at
 * its max level (after a wall breach it lands one level below its projected target), then
 * `build_done` to the owner, and `queue_empty` when the build queue is now empty.
 */
export function completeBuild(ctx: Ctx, city: CityId, item: QueueItemId): void {
  const c = draftCity(ctx, city);
  const i = c.build.findIndex((x) => x.id === item);
  const it = c.build[i];
  if (it === undefined) fail(`${city} has no build item #${item}`);
  if (ctx.now < it.end) fail(`build item #${item} of ${city} ends at ${it.end}, not ${ctx.now}`);
  materialize(ctx, city);
  c.build.splice(i, 1);
  cancelIfQueued(ctx, it.seq);
  const level = Math.min(
    buildingTable(ctx.rules, it.building).maxLevel,
    levelOf(c, it.building) + 1,
  );
  setLevel(ctx, city, it.building, level);
  emitTo(ctx, "build_done", { city, item, building: it.building, level }, owner(c));
  if (c.build.length === 0) emitTo(ctx, "queue_empty", { city, queue: BUILD_QUEUE }, owner(c));
}

/**
 * Completes recruit batch `item` (its event fired): delivers its remaining units at home
 * (`ledger.made`), then `recruit_done` to the owner, and `queue_empty` when its queue is now empty.
 */
export function completeRecruit(ctx: Ctx, city: CityId, item: QueueItemId): void {
  const c = draftCity(ctx, city);
  for (const q of ctx.rules.queues.recruit) {
    const batches = recruitQueue(c, q.id);
    const i = batches.findIndex((x) => x.id === item);
    const b = batches[i];
    if (b === undefined) continue;
    if (ctx.now < b.end) fail(`batch #${item} of ${city} ends at ${b.end}, not ${ctx.now}`);
    materialize(ctx, city);
    const rest = b.count - b.done;
    if (rest > 0) spawnUnits(ctx, city, { [b.unit]: rest });
    batches.splice(i, 1);
    cancelIfQueued(ctx, b.seq);
    emitTo(
      ctx,
      "recruit_done",
      { city, item, queue: q.id, unit: b.unit, count: b.count },
      owner(c),
    );
    if (batches.length === 0) emitTo(ctx, "queue_empty", { city, queue: q.id }, owner(c));
    return;
  }
  fail(`${city} has no recruit batch #${item}`);
}

/** Where an item is: its queue id and index. */
function locate(ctx: Ctx, c: City, item: QueueItemId): { queue: QueueId; index: number } | null {
  const b = c.build.findIndex((x) => x.id === item);
  if (b >= 0) return { queue: BUILD_QUEUE, index: b };
  for (const q of ctx.rules.queues.recruit) {
    const r = recruitQueue(c, q.id).findIndex((x) => x.id === item);
    if (r >= 0) return { queue: q.id, index: r };
  }
  return null;
}

/** `floor(cost × units × pm / 1000)` per resource. */
function refundAt(cost: Readonly<Res>, units: number, pm: number): Res {
  return resOf((id) => floorDiv(assertSafeInt(cost[id] * units * pm, "refund"), 1000));
}

function addRes(a: Res, b: Readonly<Res>): void {
  for (const id of RESOURCE_IDS) a[id] += b[id];
}

/** The refund of a build item removed now, per `queues.refund.build`. */
function buildRefund(ctx: Ctx, it: Readonly<BuildItem>): Res {
  const rule = ctx.rules.queues.refund.build;
  if (it.start > ctx.now) return refundAt(it.cost, 1, rule.queuedPm);
  if (rule.active === "prorata") {
    const remaining = Math.max(0, it.end - ctx.now);
    return resOf((id) => floorDiv(it.cost[id] * remaining, it.end - it.start));
  }
  return refundAt(it.cost, 1, rule.active.pm);
}

/**
 * The refund of a recruit batch removed now (after materialising), per `queues.refund.recruit`:
 * delivered units are kept; `uncompleted` refunds every other unit, the one in training included,
 * at `queuedPm`; `{pm}` refunds them at pm.
 */
function recruitRefund(ctx: Ctx, b: Readonly<RecruitBatch>): Res {
  const rule = ctx.rules.queues.refund.recruit;
  const left = b.count - b.done;
  if (b.start > ctx.now || rule.active === "uncompleted") {
    return refundAt(b.costEach, left, rule.queuedPm);
  }
  return refundAt(b.costEach, left, rule.active.pm);
}

/** Removes items `[from..]` of one queue, cancelling their events; returns the refund due. */
function removeTail(ctx: Ctx, c: City, queue: QueueId, from: number, withRefund: boolean): Res {
  const total = zeroRes();
  if (queue === BUILD_QUEUE) {
    for (const it of c.build.splice(from)) {
      ctx.cancel(it.seq);
      if (withRefund) addRes(total, buildRefund(ctx, it));
    }
  } else {
    for (const b of recruitQueue(c, queue).splice(from)) {
      ctx.cancel(b.seq);
      if (withRefund) addRes(total, recruitRefund(ctx, b));
    }
  }
  return total;
}

/**
 * A refund paid into a city's stock (§4.3 of perfidia-1: every addition is capped by the
 * warehouse, and the excess is reported): what was credited, and what the storage cap cut.
 */
export interface Refund {
  readonly refund: Res;
  readonly lost: Res;
}

/**
 * Tail cancel: removes `item` and every later item of its queue, so remaining end times never
 * move; refunds per `queues.refund` (an active build item pro rata or at pm, queued items at
 * `queuedPm`; a recruit batch keeps its delivered units), capped by storage. Cancels the removed
 * items' events. Returns what was credited to the stock and what the cap cut.
 */
export function cancelFrom(ctx: Ctx, city: CityId, item: QueueItemId): Refund {
  const c = draftCity(ctx, city);
  const where = locate(ctx, c, item);
  if (where === null) fail(`${city} has no queue item #${item}`);
  materialize(ctx, city);
  const due = removeTail(ctx, c, where.queue, where.index, true);
  return credit(ctx, city, due);
}

function credit(ctx: Ctx, city: CityId, due: Readonly<Res>): Refund {
  const lost = addCapped(ctx, city, due);
  return { refund: resOf((id) => due[id] - lost[id]), lost };
}

/**
 * Removes the listed items from one queue (any positions), refunding item i at `refundPm[i]` per
 * mille of its cost (a recruit batch: of its undelivered units; delivered ones are kept), capped
 * by storage. Later items keep their times: call `reflowQueue` to close the gaps. Returns what was
 * credited and what the cap cut. A building block for `cancel_queue` overrides.
 */
export function removeQueueItems(
  ctx: Ctx,
  city: CityId,
  queue: QueueId,
  items: readonly QueueItemId[],
  refundPm: readonly number[],
): Refund {
  if (items.length !== refundPm.length) fail("removeQueueItems needs one refund rate per item");
  const c = draftCity(ctx, city);
  const list: { id: QueueItemId; seq: number }[] =
    queue === BUILD_QUEUE ? c.build : recruitQueue(c, queue);
  for (const [k, id] of items.entries()) {
    const pm = must(refundPm[k], `refund rate ${k}`);
    if (!Number.isSafeInteger(pm) || pm < 0 || pm > 1000) {
      fail(`refund rate ${pm} is outside 0..1000`);
    }
    if (!list.some((x) => x.id === id) || items.indexOf(id) !== k) {
      fail(`queue ${queue} of ${city} has no item #${id}, or it is listed twice`);
    }
  }
  materialize(ctx, city);
  const due = zeroRes();
  for (const [k, id] of items.entries()) {
    const pm = must(refundPm[k], `refund rate ${k}`);
    const i = list.findIndex((x) => x.id === id);
    if (queue === BUILD_QUEUE) {
      const [it] = c.build.splice(i, 1);
      if (it === undefined) fail(`queue ${queue} of ${city} has no item #${id}`);
      ctx.cancel(it.seq);
      addRes(due, refundAt(it.cost, 1, pm));
    } else {
      const [b] = recruitQueue(c, queue).splice(i, 1);
      if (b === undefined) fail(`queue ${queue} of ${city} has no item #${id}`);
      ctx.cancel(b.seq);
      addRes(due, refundAt(b.costEach, b.count - b.done, pm));
    }
  }
  return credit(ctx, city, due);
}

/**
 * Closes the gaps of a queue: the head keeps its start if it has started, otherwise starts now;
 * every later item starts at `max(now, end of the previous one)`. Items only move earlier;
 * durations are kept; the events of moved items are rescheduled with new seqs.
 */
export function reflowQueue(ctx: Ctx, city: CityId, queue: QueueId): void {
  const c = draftCity(ctx, city);
  materialize(ctx, city);
  const list: { start: number; end: number; seq: number }[] =
    queue === BUILD_QUEUE ? c.build : recruitQueue(c, queue);
  const kind = queue === BUILD_QUEUE ? "build_done" : "recruit_done";
  let prevEnd: number | null = null;
  for (const it of list) {
    const start = prevEnd === null ? Math.min(it.start, ctx.now) : Math.max(prevEnd, ctx.now);
    const duration = it.end - it.start;
    if (start !== it.start) {
      if (start > it.start) fail(`reflow would delay an item of ${city}`);
      ctx.cancel(it.seq);
      it.start = start;
      it.end = start + duration;
      it.seq = ctx.schedule(kind, it.end, city);
    }
    prevEnd = it.end;
  }
}

/**
 * Removes every item of every queue of the city and cancels their events. With `refund`, each
 * queue is refunded as a tail cancel from its head (`cancelFrom`'s rules), capped by storage;
 * without, nothing is refunded. Delivered recruits are kept. Never emits `queue_empty`. Returns
 * what was credited and what the cap cut (both zero without `refund`).
 */
export function clearQueues(ctx: Ctx, city: CityId, refund: boolean): Refund {
  const c = draftCity(ctx, city);
  materialize(ctx, city);
  const due = removeTail(ctx, c, BUILD_QUEUE, 0, refund);
  for (const q of ctx.rules.queues.recruit) addRes(due, removeTail(ctx, c, q.id, 0, refund));
  return refund ? credit(ctx, city, due) : { refund: zeroRes(), lost: zeroRes() };
}
