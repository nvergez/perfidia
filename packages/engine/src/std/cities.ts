// City lifecycle (docs/architecture.md §5.4; perfidia-1 §7.5, §7.7, §9.7): founding, owner
// change, re-homing, disbanding and elimination. Each primitive leaves no dangling reference: no
// queue event without its item, no movement without its event, no unit without its owner.

import {
  compareIds,
  type City,
  type CityId,
  type IslandId,
  type PlayerId,
  type Stationed,
  type UnitCounts,
} from "@perfidia/protocol";
import type { Ctx } from "@perfidia/engine/contracts";
import { cancelProposalsOf, endPact, leaveAlliance } from "./diplomacy.ts";
import { citiesOf, freeSlots, travel } from "./derive.ts";
import { deleteMovement, station } from "./movement.ts";
import { clearQueues } from "./queues.ts";
import { materialize } from "./stock.ts";
import { putHome, removeUnits, spawnUnits } from "./units.ts";
import {
  cleanUnits,
  draftCity,
  emitTo,
  fail,
  hasUnits,
  must,
  readCity,
  readIsland,
} from "./util.ts";

/**
 * Founds a city of `owner` on `island`, in `slot` when it is free, else in the lowest free slot
 * (throws when none is free: the caller bounces first). The city starts from `rules.newCity`
 * (its units are new, `ledger.made`), plus `escort` at home (taken by the caller from the founding
 * movement, so not new). Emits the public `city_founded`. Returns the new city id.
 */
export function foundCity(
  ctx: Ctx,
  island: IslandId,
  owner: PlayerId,
  escort: Readonly<UnitCounts>,
  slot: number | null,
): CityId {
  readIsland(ctx.state, island);
  must(ctx.state.players[owner], `player ${owner}`);
  const free = freeSlots(ctx.read(), island);
  const chosen = slot !== null && free.includes(slot) ? slot : free[0];
  if (chosen === undefined) fail(`island ${island} has no free slot`);
  const seed = ctx.rules.newCity;
  const scale = ctx.rules.resourceScale;
  const id = ctx.nextId("c");
  const buildings: City["buildings"] = {};
  for (const b of ctx.rules.buildings) buildings[b.id] = seed.buildings[b.id] ?? 0;
  const recruit: City["recruit"] = {};
  for (const q of ctx.rules.queues.recruit) recruit[q.id] = [];
  ctx.state.cities[id] = {
    id,
    name: id,
    owner,
    island,
    slot: chosen,
    capitalOf: null,
    tag: null,
    foundedAt: ctx.now,
    stock: {
      wood: seed.stock.wood * scale,
      stone: seed.stock.stone * scale,
      gold: seed.stock.gold * scale,
    },
    stockAt: ctx.now,
    buildings,
    units: {},
    stationed: [],
    itemSeq: 0,
    build: [],
    recruit,
  };
  if (hasUnits(seed.units)) spawnUnits(ctx, id, seed.units);
  if (hasUnits(escort)) putHome(ctx, id, cleanUnits(ctx.rules, escort, "escort"));
  emitTo(
    ctx,
    "city_founded",
    { city: id, island, slot: chosen, owner },
    [{ p: owner, as: "self" }],
    true,
  );
  return id;
}

/** Moves the units of `owner` at home in `city` into a support group stationed there, homed in `home`. */
function homeUnitsToGroup(ctx: Ctx, city: City, owner: PlayerId, home: CityId): void {
  if (!hasUnits(city.units)) return;
  const units = city.units;
  city.units = {};
  station(ctx, city.id, { owner, home, role: "support", units });
}

/** Records sorted by id (`compareIds`), so iteration never depends on key insertion order. */
function byId<T extends { readonly id: string }>(items: readonly T[]): T[] {
  return items.toSorted((a, b) => compareIds(a.id, b.id));
}

function compareGroups(a: Readonly<Stationed>, b: Readonly<Stationed>): number {
  return (
    compareIds(a.owner, b.owner) ||
    compareIds(a.home, b.home) ||
    (a.role === b.role ? 0 : a.role < b.role ? -1 : 1)
  );
}

/** Re-sorts the stationed groups and merges groups of the same (owner, home, role). */
function normaliseGroups(ctx: Ctx, city: City): void {
  const merged: Stationed[] = [];
  for (const g of city.stationed.toSorted(compareGroups)) {
    const last = merged[merged.length - 1];
    if (last !== undefined && compareGroups(last, g) === 0) {
      for (const u of ctx.rules.units) {
        const n = g.units[u.id];
        if (n !== undefined) last.units[u.id] = (last.units[u.id] ?? 0) + n;
      }
    } else merged.push({ ...g, units: { ...g.units } });
  }
  city.stationed = merged;
}

/**
 * Changes the city's owner (`null`: neutral), after materialising it with the old owner's rates.
 * What is left of the former owner in the city itself is resolved so nothing dangles: remaining
 * queue items are removed without refund (rulesets clear or refund them first as their rules
 * say); the former owner's units still at home stay where they are as a support group homed in
 * the former owner's fallback city (§7.7 of perfidia-1), or are disbanded when there is none (a
 * neutral former owner, or one about to be eliminated); `hold` groups of the new owner become
 * `support`. Buildings, stock, `capitalOf` and the other stationed groups are kept. Units and
 * movements homed in the city elsewhere are the caller's: `rehomeAll`, `disbandHomed` or
 * `eliminate`. Emits nothing: the ruleset emits `city_conquered` with its own audience.
 */
export function transferCity(ctx: Ctx, city: CityId, to: PlayerId | null): void {
  const c = draftCity(ctx, city);
  const from = c.owner;
  if (from === to) return;
  if (to !== null) must(ctx.state.players[to], `player ${to}`);
  materialize(ctx, city);
  clearQueues(ctx, city, false);
  if (hasUnits(c.units)) {
    const fallback =
      from === null ? undefined : citiesOf(ctx.read(), from).find((id) => id !== city);
    if (from === null || fallback === undefined) {
      removeUnits(ctx, { at: "home", city }, { ...c.units }, "disbanded");
    } else homeUnitsToGroup(ctx, c, from, fallback);
  }
  c.owner = to;
  for (const g of c.stationed) if (g.owner === to && g.role === "hold") g.role = "support";
  normaliseGroups(ctx, c);
}

/**
 * Re-homes to `to` everything of `to`'s owner that is homed in `from` (§7.7 of perfidia-1):
 * stationed groups anywhere keep their place and take the new home (a group stationed in `to`
 * itself is simply at home there); outbound movements continue and will return to `to`; returns
 * already heading to `from` sail on, arriving at `old arrival + travel(from's island, to's
 * island)` with a rescheduled event. That owner's units still at home in `from` become a group
 * stationed in `from` homed in `to`.
 */
export function rehomeAll(ctx: Ctx, from: CityId, to: CityId): void {
  if (from === to) return;
  const src = draftCity(ctx, from);
  const dst = readCity(ctx.state, to);
  const owner = dst.owner;
  if (owner === null) fail(`cannot re-home units into the neutral city ${to}`);
  materialize(ctx, from);
  if (src.owner === owner) homeUnitsToGroup(ctx, src, owner, to);
  for (const c of byId(Object.values(ctx.state.cities))) {
    const moving = c.stationed.filter((g) => g.home === from && g.owner === owner);
    if (moving.length === 0) continue;
    if (c.id === to) {
      // Units stationed in their new home are simply at home there.
      c.stationed = c.stationed.filter((g) => !moving.includes(g));
      for (const g of moving) putHome(ctx, to, g.units);
    } else {
      for (const g of moving) g.home = to;
      normaliseGroups(ctx, c);
    }
  }
  const movements = Object.values(ctx.state.movements)
    .filter((m) => m.home === from && m.owner === owner)
    .toSorted((a, b) => compareIds(a.id, b.id));
  for (const m of movements) {
    m.home = to;
    if (m.kind !== "return") continue;
    const extra = travel(ctx.read(), src.island, dst.island, {
      kind: "return",
      units: { ...m.units },
    });
    ctx.cancel(m.seq);
    m.to = to;
    m.toIsland = dst.island;
    m.arriveAt += extra;
    m.seq = ctx.schedule("arrive_return", m.arriveAt, m.id);
  }
}

/**
 * Disbands every unit homed in the city, wherever it is (`ledger.gone`): at home, in stationed
 * groups elsewhere, and in movements, which are deleted with their events and cargo. Movements
 * that carry no units (spies, shipments) keep flying. Call it before putting new units at home.
 */
export function disbandHomed(ctx: Ctx, city: CityId): void {
  const c = draftCity(ctx, city);
  materialize(ctx, city);
  if (hasUnits(c.units)) removeUnits(ctx, { at: "home", city }, { ...c.units }, "disbanded");
  for (const host of byId(Object.values(ctx.state.cities))) {
    for (const g of host.stationed.filter((x) => x.home === city)) {
      const slot = {
        at: "stationed",
        city: host.id,
        owner: g.owner,
        home: g.home,
        role: g.role,
      } as const;
      removeUnits(ctx, slot, { ...g.units }, "disbanded");
    }
  }
  const movements = Object.values(ctx.state.movements)
    .filter((m) => m.home === city && hasUnits(m.units))
    .toSorted((a, b) => compareIds(a.id, b.id));
  for (const m of movements) {
    removeUnits(ctx, { at: "movement", id: m.id }, { ...m.units }, "disbanded");
    deleteMovement(ctx, m.id);
  }
}

/**
 * Eliminates `p`, who must own no city any more: the public `player_eliminated`, then every unit
 * of `p` in stationed groups and movements is removed (`ledger.gone`) and its movements deleted
 * with their events, its open proposals are cancelled, it leaves its alliance and its pacts end
 * (public, cause `eliminated`), and it is marked eliminated now. A ruleset breaks the sieges that
 * depended on `p` itself.
 */
export function eliminate(ctx: Ctx, p: PlayerId): void {
  const player = must(ctx.state.players[p], `player ${p}`);
  if (!player.alive) fail(`${p} is already eliminated`);
  const owned = citiesOf(ctx.read(), p);
  if (owned.length > 0) fail(`${p} still owns ${owned.join(", ")}`);
  emitTo(ctx, "player_eliminated", { player: p }, [{ p, as: "self" }], true);
  for (const host of byId(Object.values(ctx.state.cities))) {
    for (const g of host.stationed.filter((x) => x.owner === p)) {
      const slot = {
        at: "stationed",
        city: host.id,
        owner: p,
        home: g.home,
        role: g.role,
      } as const;
      removeUnits(ctx, slot, { ...g.units }, "disbanded");
    }
  }
  const movements = Object.values(ctx.state.movements)
    .filter((m) => m.owner === p)
    .toSorted((a, b) => compareIds(a.id, b.id));
  for (const m of movements) {
    if (hasUnits(m.units))
      removeUnits(ctx, { at: "movement", id: m.id }, { ...m.units }, "disbanded");
    deleteMovement(ctx, m.id);
  }
  cancelProposalsOf(ctx, p);
  leaveAlliance(ctx, p, "eliminated");
  const partners = ctx.state.pacts
    .filter((x) => x.a === p || x.b === p)
    .map((x) => (x.a === p ? x.b : x.a))
    .toSorted(compareIds);
  for (const q of partners) endPact(ctx, p, q, "eliminated");
  player.alive = false;
  player.eliminatedAt = ctx.now;
}
