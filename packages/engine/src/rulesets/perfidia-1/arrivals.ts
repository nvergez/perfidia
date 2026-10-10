import type { CityId, JsonObject, MovementId, UnitCounts } from "@perfidia/protocol";
import {
  cleanUnits,
  deleteMovement,
  deliverShipment,
  deliverSupport,
  foundCity,
  freeSlots,
  hasUnits,
  materialize,
  queueEtas,
  removeUnits,
  stockAt,
  unitsAtHome,
  unitsPop,
} from "@perfidia/engine/std";
import { bounceHome } from "./battle.ts";
import { cityOf, draftMovementOf, fail, movementOf, type PCtx, type PRead } from "./common.ts";
import { siegeOf } from "./ext.ts";
import { counterIntel, spySucceeds } from "./spy.ts";

// The non-battle arrivals of perfidia-1 (§7.5, §10), siege-aware: only the besieger may reinforce
// a besieged city, and nothing else reaches it.

/** Land units of `units` only. */
function landOnly(r: PRead, units: Readonly<UnitCounts>): UnitCounts {
  const out: UnitCounts = {};
  for (const u of r.rules.units) {
    const n = units[u.id] ?? 0;
    if (u.domain === "land" && n > 0) out[u.id] = n;
  }
  return out;
}

/** Σ pop of the land units present in the city, every owner and the garrison included (§10). */
export function landPopPresent(r: PRead, city: CityId): number {
  const c = cityOf(r.state, city);
  let pop = unitsPop(r.rules, landOnly(r, unitsAtHome(r, city)));
  for (const g of c.stationed) pop += unitsPop(r.rules, landOnly(r, g.units));
  return pop;
}

/**
 * The spy report of §10: a snapshot at arrival of the city's buildings, stock, wall, siege state,
 * units present by owner and role (home, stationed support, garrison) and queues with their end
 * times. Never units away or movements.
 */
function spySnapshot(r: PRead, city: CityId, report: string): JsonObject {
  const c = cityOf(r.state, city);
  const wall = r.rules.roles.wall;
  const siege = siegeOf(r.ext(), city);
  const units: JsonObject[] = [];
  const home = cleanUnits(r.rules, unitsAtHome(r, city));
  if (hasUnits(home)) units.push({ owner: c.owner ?? "neutral", role: "home", units: home });
  for (const g of c.stationed) {
    units.push({
      owner: g.owner,
      role: g.role === "hold" ? "garrison" : "stationed",
      home: g.home,
      units: cleanUnits(r.rules, g.units),
    });
  }
  const buildings: Record<string, number> = {};
  for (const b of r.rules.buildings) buildings[b.id] = c.buildings[b.id] ?? 0;
  const queues: JsonObject[] = queueEtas(r, city).map((q) =>
    q.kind === "build"
      ? { queue: q.queue, item: q.item, building: q.building, level: q.level, end: q.end }
      : { queue: q.queue, item: q.item, unit: q.unit, count: q.count, done: q.done, end: q.end },
  );
  return {
    report,
    city,
    owner: c.owner,
    island: c.island,
    buildings,
    stock: { ...stockAt(r, city) },
    wall: wall === null ? 0 : (c.buildings[wall] ?? 0),
    siege: siege === null ? null : { by: siege.by, endsAt: siege.endsAt },
    units,
    queues,
  };
}

/**
 * `arrive.spy` (§10): succeeds when the gold exceeds the counter-intel (ties to the target), or
 * when the spier owns the target by now. Success: a report to the spier only. Failure: the spier
 * learns only that it failed; the owner learns the spier, the origin and the gold. The spy is
 * consumed either way.
 */
export function arriveSpy(ctx: PCtx, m: MovementId): void {
  const mv = movementOf(ctx.state, m);
  const city = mv.to ?? fail(`spy ${m} has no target city`);
  materialize(ctx, city);
  const r = ctx.read();
  const c = cityOf(ctx.state, city);
  const spier = mv.owner;
  const wall = r.rules.roles.wall;
  const counter = counterIntel(
    ctx.config,
    wall === null ? 0 : (c.buildings[wall] ?? 0),
    landPopPresent(r, city),
  );
  if (c.owner === spier || spySucceeds(mv.gold, counter)) {
    const report = ctx.nextId("r", spier);
    ctx.emit({
      type: "spy_report",
      public: false,
      to: [{ p: spier, as: "self" }],
      data: spySnapshot(ctx.read(), city, report),
    });
  } else {
    ctx.emit({
      type: "spy_failed",
      public: false,
      to: [{ p: spier, as: "self" }],
      data: { movement: m, city },
    });
    if (c.owner !== null) {
      ctx.emit({
        type: "spy_detected",
        public: false,
        to: [{ p: c.owner, as: "target" }],
        data: { city, by: spier, from: mv.from, gold: mv.gold },
      });
    }
  }
  deleteMovement(ctx, m);
}

/**
 * `arrive.support` (§7.5): joins the garrison of a city the mover besieges, bounces from a city
 * besieged by anyone else, becomes a stationed group in a city still owned by its recorded party,
 * and bounces otherwise.
 */
export function arriveSupport(ctx: PCtx, m: MovementId): void {
  const mv = movementOf(ctx.state, m);
  const city = mv.to ?? fail(`support ${m} has no target city`);
  const siege = siegeOf(ctx.ext(), city);
  if (siege !== null) {
    if (siege.by === mv.owner) deliverSupport(ctx, m, "hold");
    else bounceHome(ctx, m, "target_besieged");
    return;
  }
  const owner = cityOf(ctx.state, city).owner;
  if (owner !== null && owner === mv.party) deliverSupport(ctx, m, "support");
  else bounceHome(ctx, m, "target_changed");
}

/**
 * `arrive.shipment` (§7.5): delivered (capped; the overflow is reported to the recipient only) to a
 * city still owned by its owner at launch and not besieged; bounces with its cargo otherwise.
 */
export function arriveShipment(ctx: PCtx, m: MovementId): void {
  const mv = movementOf(ctx.state, m);
  const city = mv.to ?? fail(`shipment ${m} has no target city`);
  if (siegeOf(ctx.ext(), city) !== null) {
    bounceHome(ctx, m, "target_besieged");
    return;
  }
  const owner = cityOf(ctx.state, city).owner;
  if (owner !== null && owner === mv.party) deliverShipment(ctx, m);
  else bounceHome(ctx, m, "target_changed");
}

/**
 * `arrive.found` (§7.5): a new city in the lowest free slot of the island, with the next city id;
 * one settler is consumed and the rest of the group (escort, ships, extra settlers) is re-homed to
 * it. Bounces when the island has no free slot left.
 */
export function arriveFound(ctx: PCtx, m: MovementId): void {
  const mv = movementOf(ctx.state, m);
  const settler = ctx.rules.roles.settler;
  if (freeSlots(ctx.read(), mv.toIsland).length === 0) {
    bounceHome(ctx, m, "no_free_slot");
    return;
  }
  if ((mv.units[settler] ?? 0) < 1) {
    bounceHome(ctx, m, "no_settler");
    return;
  }
  const island = mv.toIsland;
  const owner = mv.owner;
  removeUnits(ctx, { at: "movement", id: m }, { [settler]: 1 }, "consumed");
  const draft = draftMovementOf(ctx, m);
  const escort = cleanUnits(ctx.rules, draft.units);
  draft.units = {};
  foundCity(ctx, island, owner, escort, null);
  deleteMovement(ctx, m);
}
