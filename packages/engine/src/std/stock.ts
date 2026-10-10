// Stock primitives (docs/architecture.md §4.3). `materialize` brings a city's stock and trickled
// recruits up to `ctx.now`; every primitive that changes stock, rates, caps, levels, units or
// ownership calls it first, so results never depend on when a city was materialised.

import { RESOURCE_IDS, type BuildingId, type CityId, type Res } from "@perfidia/protocol";
import { floorDiv } from "@perfidia/engine/core";
import type { Ctx } from "@perfidia/engine/contracts";
import { stockSecondsAt, storageCap, trickledAt } from "./derive.ts";
import { addInto, assertRes, buildingTable, draftCity, fail, ledgerOf, resOf } from "./util.ts";

/**
 * Brings the city's stock and trickled recruits up to `ctx.now`: stock to its accrued value with
 * `stockAt = now`, and every unit completed by now moved from its batch to the owner's units at
 * home (`ledger.made`). Idempotent and path-independent (P2).
 */
export function materialize(ctx: Ctx, city: CityId): void {
  const c = draftCity(ctx, city);
  if (c.stockAt !== ctx.now) {
    c.stock = stockSecondsAt(ctx.read(), city, ctx.now);
    c.stockAt = ctx.now;
  }
  if (ctx.rules.queues.delivery !== "trickle") return;
  const made = ledgerOf(ctx, c.owner).made;
  for (const q of ctx.rules.queues.recruit) {
    for (const b of c.recruit[q.id] ?? []) {
      const completed = trickledAt(ctx.rules, b, ctx.now);
      if (completed <= b.done) continue;
      const delivered = { [b.unit]: completed - b.done };
      addInto(ctx.rules, c.units, delivered);
      addInto(ctx.rules, made, delivered);
      b.done = completed;
    }
  }
}

/**
 * Pays `cost` (whole units) from the city's stock. Validation must have checked it: a visible stock
 * below the cost is a StdError.
 */
export function spend(ctx: Ctx, city: CityId, cost: Readonly<Res>): void {
  assertRes(cost, `cost paid by ${city}`);
  materialize(ctx, city);
  const c = draftCity(ctx, city);
  const scale = ctx.rules.resourceScale;
  for (const id of RESOURCE_IDS) {
    if (c.stock[id] < cost[id] * scale) {
      fail(`${city} cannot pay ${cost[id]} ${id}: has ${floorDiv(c.stock[id], scale)}`);
    }
  }
  for (const id of RESOURCE_IDS) c.stock[id] -= cost[id] * scale;
}

/**
 * Adds `res` (whole units) to the city's stock, capped by its storage (§4.3), and returns what was
 * lost to the cap, in whole units as the visible stock shows it.
 */
export function addCapped(ctx: Ctx, city: CityId, res: Readonly<Res>): Res {
  assertRes(res, `resources added to ${city}`);
  materialize(ctx, city);
  const c = draftCity(ctx, city);
  const scale = ctx.rules.resourceScale;
  const capS = storageCap(ctx.read(), city) * scale;
  return resOf((id) => {
    const before = c.stock[id];
    const wanted = before + res[id] * scale;
    const after = before >= capS ? before : Math.min(capS, wanted);
    c.stock[id] = after;
    return floorDiv(wanted, scale) - floorDiv(after, scale);
  });
}

/** Sets the completed level of building `b`, after materialising (rates and caps may change). */
export function setLevel(ctx: Ctx, city: CityId, b: BuildingId, level: number): void {
  const table = buildingTable(ctx.rules, b);
  if (!Number.isSafeInteger(level) || level < 0 || level > table.maxLevel) {
    fail(`level ${level} of ${b} is outside 0..${table.maxLevel}`);
  }
  materialize(ctx, city);
  draftCity(ctx, city).buildings[b] = level;
}
