// Own-wake pacing (docs/architecture.md §11.1, §11.2), opt-in per strategy (expander@2, turtle@2,
// opportunist@2): every queue that empties wakes the seat on its own budget (perfidia-1 §14.2), so
// a bot that starts short batches in empty queues spends its day's own wakes by the afternoon and
// sleeps through the evening. An empty recruit queue therefore gets a batch only when that batch
// lasts until the seat's next own wake (its cadence, or later once the own wakes left must be
// spread over the rest of the day): longer batches, fewer wakes. Otherwise the resources wait for
// that wake. Queues already running are topped up as usual: that only moves their end later. An
// empty build queue (its items' lengths are unknown before they are ordered) is started only while
// the seat's own wakes keep to an even share of the day's budget: ahead of it, it waits.

import { CityIdSchema, compareIds, z, type QueueId, type UnitId } from "@perfidia/protocol";
import { addRes, countOf, DAY, pmRes, scaleRes, timesAffordable, ZERO } from "./kit.ts";
import { ownWakesBefore, type Planner } from "./plan.ts";
import type { OwnCity, World } from "./world.ts";

/** Packs of the unit mix below which `units` keeps the surplus (its default `minPacks`). */
const MIN_PACKS = 3;
/** Carriers ordered in an empty queue at least (fewer wait for the shortfall to grow). */
const CARRIER_BATCH = 3;
/** Own wakes a seat may run ahead of an even share of the day's budget (`wakesInHand`). */
const PACE_SLACK = 2;

/**
 * The time each own wake left today must cover so that the budget lasts until the day ends, or
 * null when the budget covers the strategy's cadence.
 */
export function ownWakeSpread(w: World, cadence: number): number | null {
  const rest = DAY - (w.t % DAY);
  const left = w.briefing.budget.ownWakesLeft;
  const spread = Math.ceil(rest / Math.max(1, left));
  return spread > cadence ? Math.min(spread, rest) : null;
}

/**
 * The next own wake the seat can count on: its cadence, or later when the own wakes left today
 * must be spread over the rest of the day (`ownWakeSpread`).
 */
export function nextOwnWake(w: World, cadence: number): number {
  return w.t + (ownWakeSpread(w, cadence) ?? cadence);
}

/**
 * Seconds to train one `unit` in `c`: from the rules' duration table when `rules` carries it (it
 * may leave it out), else from a batch of that unit seen in an own city's view this turn (that
 * city's first), remembered in the flag `u<unit>` for the turns that see none; null when unknown.
 */
export function unitTime(p: Planner, c: OwnCity, unit: UnitId): number | null {
  const { w } = p;
  const kit = w.kit;
  const row = kit.units.get(unit);
  const q = row === undefined ? undefined : kit.queues.get(row.queue);
  if (row === undefined || q === undefined || c.levels === null) return null;
  const table = row.time;
  if (table !== undefined && table.length > 0) {
    return table[Math.max(0, Math.min(table.length - 1, c.levels[q.building] ?? 0))] ?? null;
  }
  const flag = `u${unit}`;
  const learn = (each: number): number => {
    p.setFlag(flag, each);
    return each;
  };
  const views = [w.views.get(c.id), ...w.cities.map((x) => w.views.get(x.id))];
  for (const view of views) {
    if (view === undefined || view.access !== "full") continue;
    for (const b of view.recruit[row.queue] ?? []) {
      if (b.unit !== unit || b.count <= 0) continue;
      const each = Math.floor((b.end[0] - b.start[0]) / b.count);
      if (each > 0) return learn(each);
    }
  }
  // A batch queued behind another starts when that one ends at the earliest (the briefing has no
  // start times): the gap between their ends bounds its length from above, and the smallest such
  // bound is kept. Batches still queued, and the ones the briefing reports done, both count.
  let best: number | null = null;
  const bound = (prevEnd: number, end: number, count: number): void => {
    const each = Math.floor((end - prevEnd) / Math.max(1, count));
    if (each > 0 && (best === null || each < best)) best = each;
  };
  for (const city of [c, ...w.cities]) {
    const batches = city.recruit[row.queue] ?? [];
    for (let i = 1; i < batches.length; i += 1) {
      const b = batches[i]!;
      if (b.unit === unit) bound(batches[i - 1]!.end, b.end, b.count);
    }
  }
  const done = new Map<string, number>();
  for (const e of w.briefing.events) {
    if (e.type !== "recruit_done" || e["queue"] !== row.queue) continue;
    const at: unknown = e["at"];
    const t: unknown = Array.isArray(at) ? at[0] : at;
    const city = e["city"];
    const count = e["count"];
    if (typeof t !== "number" || typeof city !== "string" || typeof count !== "number") continue;
    const prev = done.get(city);
    if (prev !== undefined && e["unit"] === unit && t >= prev) bound(prev, t, count);
    done.set(city, t);
  }
  if (best !== null) return learn(best);
  const known = p.flag(flag);
  if (known !== null) return known;
  // Not seen yet: a unit of the same queue trains at that queue building's pace too.
  for (const other of kit.units.values()) {
    if (other.id === unit || other.queue !== row.queue || other.id === kit.roles.founder) continue;
    const each = p.flag(`u${other.id}`);
    if (each !== null) return each;
  }
  return null;
}

/**
 * Closes, for this turn, every empty recruit queue whose batch (what `units` would order there:
 * the strategy's mix and its carriers) would end before the next own wake (`nextOwnWake`) less the
 * wake grouping window: that batch would wake the seat on its own budget. The resources wait for
 * that wake, which then orders a batch long enough. A queue is left open when its batch is bound
 * by pop (waiting would not make it longer) or when the batch's length is unknown. Call it after
 * the moves that recruit on purpose (founders, carriers for a founding) and before `units`.
 */
export function paceRecruits(p: Planner): void {
  const { w, k } = p;
  const kit = w.kit;
  const until = nextOwnWake(w, k.cadence) - kit.gateway.groupWindow;
  const roles: { unit: UnitId | null; weight: number }[] = [
    { unit: kit.roles.defender, weight: k.mix.defender },
    { unit: kit.roles.attacker, weight: k.mix.attacker },
    { unit: kit.roles.navy, weight: k.mix.navy },
  ];
  const { attacker, carrier } = kit.roles;
  for (const c of w.cities) {
    if (c.blocked || c.levels === null) continue;
    const picks = roles.filter(
      (r): r is { unit: UnitId; weight: number } =>
        r.unit !== null && r.weight > 0 && p.canRecruit(c, r.unit),
    );
    let pack = ZERO;
    let packPop = 0;
    for (const r of picks) {
      const row = kit.units.get(r.unit)!;
      pack = addRes(pack, scaleRes(row.cost, r.weight));
      packPop += row.pop * r.weight;
    }
    const budget = pmRes(p.budgetOf(c.id), k.spendPm);
    const free = Math.max(0, p.popFreeOf(c.id));
    const byStock = picks.length === 0 ? 0 : timesAffordable(budget, pack);
    const byPop = Math.floor(free / Math.max(1, packPop));
    const packs = Math.min(byStock, byPop);
    const lasts = new Map<QueueId, number | null>();
    const add = (unit: UnitId, n: number): void => {
      const queue = kit.units.get(unit)?.queue;
      if (queue === undefined || n <= 0) return;
      const each = unitTime(p, c, unit);
      const before = lasts.has(queue) ? (lasts.get(queue) ?? null) : 0;
      lasts.set(queue, before === null || each === null ? null : before + n * each);
    };
    if (packs >= (k.minPacks ?? MIN_PACKS) && byStock < byPop) {
      for (const r of picks) {
        const row = kit.units.get(r.unit)!;
        const qmax = kit.queues.get(row.queue)?.maxCount ?? row.maxPerOrder;
        add(r.unit, Math.min(packs * r.weight, row.maxPerOrder, qmax));
      }
    }
    // The carriers `units` keeps for the attackers.
    if (k.carriers && attacker !== null && carrier !== null && p.canRecruit(c, carrier)) {
      const row = kit.units.get(carrier)!;
      const apop = kit.units.get(attacker)?.pop ?? 1;
      const atk = countOf(c.units, attacker) + p.queued(c, attacker);
      const have = countOf(c.units, carrier) + p.queued(c, carrier);
      const want = row.capacity > 0 ? Math.ceil((atk * apop) / row.capacity) + 1 - have : 0;
      const n = Math.min(
        want,
        timesAffordable(budget, row.cost),
        Math.floor(free / Math.max(1, row.pop)),
        row.maxPerOrder,
      );
      // A carrier or two at a time would empty the queue (and wake the seat) every turn.
      if (n > 0 && n < CARRIER_BATCH) lasts.set(row.queue, lasts.get(row.queue) ?? 1);
      else add(carrier, n);
    }
    for (const [queue, length] of lasts) {
      const q = kit.queues.get(queue);
      if (q === undefined || length === null || length <= 0) continue;
      if ((c.recruit[queue]?.length ?? 0) > 0) continue;
      // A batch ordered earlier this turn (a founder, carriers for a founding) already runs there.
      if (p.batchRoomOf(c.id, queue) < q.maxBatches) continue;
      if (w.t + length < until) p.capBatchRoom(c.id, queue, 0);
    }
  }
}

const BuildArgs = z.looseObject({ city: CityIdSchema });
const RecruitArgs = z.looseObject({
  city: CityIdSchema,
  orders: z.array(z.looseObject({ unit: z.string(), count: z.union([z.int(), z.literal("max")]) })),
});

/**
 * The own wakes this turn's calls add before `until`: one per queue they start that was idle (a
 * city's build queue, or one of its recruit queues) unless its orders are known to last until then
 * (build items' lengths are unknown before they are ordered; a recruit batch's comes from
 * `unitTime`, and a `"max"` order counts as unknown).
 */
export function plannedWakes(p: Planner, until: number): number {
  const { w } = p;
  const kit = w.kit;
  const builds = new Set<string>();
  const lengths = new Map<string, number | null>();
  for (const c of p.calls) {
    if (c.tool === "build") {
      const args = BuildArgs.safeParse(c.args);
      const city = args.success ? p.city(args.data.city) : undefined;
      if (city !== undefined && city.build.length === 0) builds.add(city.id);
    } else if (c.tool === "recruit") {
      const args = RecruitArgs.safeParse(c.args);
      const city = args.success ? p.city(args.data.city) : undefined;
      if (!args.success || city === undefined) continue;
      for (const o of args.data.orders) {
        const queue = kit.units.get(o.unit)?.queue;
        if (queue === undefined || (city.recruit[queue]?.length ?? 0) > 0) continue;
        const key = `${city.id}/${queue}`;
        const each = o.count === "max" ? null : unitTime(p, city, o.unit);
        const before = lengths.has(key) ? (lengths.get(key) ?? null) : 0;
        lengths.set(
          key,
          before === null || each === null || o.count === "max" ? null : before + o.count * each,
        );
      }
    }
  }
  let n = builds.size;
  for (const length of lengths.values()) if (length === null || w.t + length < until) n += 1;
  return n;
}

/**
 * The own wakes the seat can still spend before its next own wake (`nextOwnWake`) while keeping to
 * an even share of the day's budget, plus `PACE_SLACK` (never more than the budget): that share at
 * its next wake, less the own wakes used today, those already due before it (its queues that empty
 * and its reports that land, the spies planned this turn included, `ownWakesBefore`), those this
 * turn's calls add (`plannedWakes`) and that next wake itself when it falls today. A seat that spent
 * extra wakes in the morning gets them back as the day goes on; one that kept to its share has
 * `PACE_SLACK` in hand.
 */
export function wakesInHand(p: Planner): number {
  const { w, k } = p;
  const g = w.kit.gateway;
  const start = w.day * DAY;
  const end = start + DAY;
  const next = Math.min(nextOwnWake(w, k.cadence), end);
  const share = Math.min(
    g.ownWakesPerDay,
    Math.floor((g.ownWakesPerDay * (next - start)) / DAY) + PACE_SLACK,
  );
  const used = g.ownWakesPerDay - w.briefing.budget.ownWakesLeft;
  const due = ownWakesBefore(p, next) + plannedWakes(p, next - g.groupWindow);
  return share - used - due - (next < end ? 1 : 0);
}

/**
 * Starts an empty build queue only while the seat has a wake in hand (`wakesInHand`): an item
 * started now may end, and wake the seat, before its next own wake. Each such queue started counts
 * as one wake, the richest cities first (they order the most items, the longest queues); the others
 * wait for a later wake. A city whose stock nears its storage cap builds anyway (its production
 * would be lost). Call it before `economy`.
 */
export function paceBuilds(p: Planner): void {
  const { w } = p;
  const idle: { c: OwnCity; stock: number; full: boolean }[] = [];
  for (const c of w.cities) {
    if (c.blocked || c.build.length > 0) continue;
    const s = p.stockOf(c.id);
    const full = Math.max(s.wood, s.stone, s.gold) * 10 >= c.cap * 8;
    idle.push({ c, stock: s.wood + s.stone + s.gold, full });
  }
  if (idle.length === 0) return;
  let hand = wakesInHand(p);
  const order = idle.toSorted(
    (a, b) => Number(b.full) - Number(a.full) || b.stock - a.stock || compareIds(a.c.id, b.c.id),
  );
  for (const { c, full } of order) {
    hand -= 1;
    if (!full && hand < 0) p.capBuildRoom(c.id, 0);
  }
}
