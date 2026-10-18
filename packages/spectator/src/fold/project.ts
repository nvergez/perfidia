import { floorDiv } from "@perfidia/engine/core";
import type { ReadCtx } from "@perfidia/engine/contracts";
import {
  BUILD_QUEUE,
  popCap,
  rates,
  relationsOf,
  storageCap,
  unitsPop,
} from "@perfidia/engine/std";
import type { SeatVisibility } from "@perfidia/gateway/present";
import type {
  Alliance,
  City,
  CityEnt,
  DeepReadonly,
  FramePact,
  FrameProposal,
  Island,
  Movement,
  MovementEnt,
  PlayerEnt,
  PlayerId,
  QueueEnt,
  Res,
  Standing,
  TurnedAt,
  UnitCounts,
} from "@perfidia/protocol";
import { cleanText } from "../clean.ts";

// The projection (phase-3 design §2.6): the engine state as spectators see it, built from the
// engine's read view and the ruleset's public hooks. Materialised values only: a city's stock is
// the stored stock in whole units at its `stockAt`, with its production rate per hour, and a
// recruit batch's `done` is the stored count; nothing is derived at the current time, so an entity
// changes only when an act or an event changed what it is built from. Records copied from the state
// get their keys in code-unit order, so an entity's JSON depends on its content, not on history.

type Read = DeepReadonly<ReadCtx["state"]>;

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A fresh copy of a record of numbers, keys in code-unit order. */
export function sortedCounts(rec: Readonly<Record<string, number>>): Record<string, number> {
  const keys = Object.keys(rec);
  let sorted = true;
  for (let i = 1; i < keys.length && sorted; i += 1) {
    sorted = byCodeUnit(keys[i - 1] ?? "", keys[i] ?? "") < 0;
  }
  const out: Record<string, number> = {};
  for (const k of sorted ? keys : keys.toSorted(byCodeUnit)) {
    const v = rec[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

const res = (r: DeepReadonly<Res>): Res => ({ wood: r.wood, stone: r.stone, gold: r.gold });

/**
 * Pop used per city in one pass: every unit homed there wherever it is (at home, stationed,
 * moving) and the units still in its recruit queues (`std.popUsed`, for all cities at once).
 */
export function popUsedByCity(r: ReadCtx): Map<string, number> {
  const rules = r.rules;
  const used = new Map<string, number>();
  const add = (city: string, n: number): void => {
    used.set(city, (used.get(city) ?? 0) + n);
  };
  for (const c of Object.values(r.state.cities)) {
    add(c.id, unitsPop(rules, c.units));
    for (const q of rules.queues.recruit) {
      for (const b of c.recruit[q.id] ?? []) add(c.id, (b.count - b.done) * b.popEach);
    }
    for (const g of c.stationed) add(g.home, unitsPop(rules, g.units));
  }
  for (const m of Object.values(r.state.movements)) add(m.home, unitsPop(rules, m.units));
  return used;
}

/** Every unit each player owns: at home in its cities, stationed anywhere, moving. */
export function armies(r: ReadCtx): Map<PlayerId, UnitCounts> {
  const out = new Map<PlayerId, UnitCounts>();
  const add = (p: PlayerId, units: DeepReadonly<UnitCounts>): void => {
    let acc = out.get(p);
    if (acc === undefined) {
      acc = {};
      out.set(p, acc);
    }
    for (const [u, n] of Object.entries(units)) acc[u] = (acc[u] ?? 0) + n;
  };
  for (const c of Object.values(r.state.cities)) {
    if (c.owner !== null) add(c.owner, c.units);
    for (const g of c.stationed) add(g.owner, g.units);
  }
  for (const m of Object.values(r.state.movements)) add(m.owner, m.units);
  return out;
}

/** A city as spectators see it. `viewer` is passed to `publicCity` (its output must not depend on it). */
export function cityEnt(
  r: ReadCtx,
  vis: SeatVisibility,
  c: DeepReadonly<City>,
  popUsed: number,
  viewer: PlayerId,
): CityEnt {
  const scale = r.rules.resourceScale;
  return {
    id: c.id,
    name: cleanText(c.name),
    owner: c.owner,
    island: c.island,
    slot: c.slot,
    capitalOf: c.capitalOf,
    tag: c.tag,
    buildings: sortedCounts(c.buildings),
    units: sortedCounts(c.units),
    stationed: c.stationed.map((g) => ({
      owner: g.owner,
      home: g.home,
      role: g.role,
      units: sortedCounts(g.units),
    })),
    stock: {
      wood: floorDiv(c.stock.wood, scale),
      stone: floorDiv(c.stock.stone, scale),
      gold: floorDiv(c.stock.gold, scale),
    },
    stockAt: c.stockAt,
    perHour: rates(r, c.id),
    cap: storageCap(r, c.id),
    pop: { used: popUsed, cap: popCap(r, c.id) },
    ext: vis.publicCity(viewer, c.id),
  };
}

/** The build items and recruit batches of a city, by `c3#7` key, added to `out`. */
export function queueEnts(r: ReadCtx, c: DeepReadonly<City>, out: Map<string, QueueEnt>): void {
  for (const b of c.build) {
    out.set(`${c.id}#${b.id}`, {
      city: c.id,
      item: b.id,
      queue: BUILD_QUEUE,
      building: b.building,
      level: b.level,
      unit: null,
      count: null,
      done: null,
      start: b.start,
      end: b.end,
    });
  }
  for (const q of r.rules.queues.recruit) {
    for (const b of c.recruit[q.id] ?? []) {
      out.set(`${c.id}#${b.id}`, {
        city: c.id,
        item: b.id,
        queue: q.id,
        building: null,
        level: null,
        unit: b.unit,
        count: b.count,
        done: b.done,
        start: b.start,
        end: b.end,
      });
    }
  }
}

/** `a + (b − a) · num / den`, rounded down, `num / den` clamped to [0, 1]. */
function lerp(a: number, b: number, num: number, den: number): number {
  if (den <= 0 || num >= den) return b;
  if (num <= 0) return a;
  return a + Math.floor(((b - a) * num) / den);
}

/**
 * Where a movement was when it turned back at `at`: its position on the way out, from the entity
 * it was before (a recall rewrites `from`, `departAt` and `arriveAt` to the turn-back time and the
 * origin).
 */
export function turnedAtOf(
  prev: MovementEnt,
  at: number,
  islands: Readonly<Record<string, DeepReadonly<Island>>>,
): TurnedAt | null {
  const a = islands[prev.fromIsland];
  const b = islands[prev.toIsland];
  if (a === undefined || b === undefined) return null;
  const num = at - prev.departAt;
  const den = prev.arriveAt - prev.departAt;
  return { t: at, x: lerp(a.x, b.x, num, den), y: lerp(a.y, b.y, num, den) };
}

export function movementEnt(m: DeepReadonly<Movement>, turnedAt: TurnedAt | null): MovementEnt {
  return {
    id: m.id,
    kind: m.kind,
    owner: m.owner,
    home: m.home,
    from: m.from,
    fromIsland: m.fromIsland,
    to: m.to,
    toIsland: m.toIsland,
    party: m.party,
    units: sortedCounts(m.units),
    cargo: res(m.cargo),
    gold: m.gold,
    departAt: m.departAt,
    arriveAt: m.arriveAt,
    back: m.back === null ? null : { kind: m.back.kind, at: m.back.at },
    turnedAt,
  };
}

/** The ruleset's standings, or the result's once the match has ended (its ranking decides). */
export function standingsOf(r: ReadCtx): Standing[] {
  const result = r.state.result;
  const list = result === null ? r.ruleset.hooks.standings(r) : result.standings;
  return list.map((s) => ({
    player: s.player,
    rank: s.rank,
    score: s.score,
    parts: sortedCounts(s.parts),
    cities: s.cities,
    alive: s.alive,
  }));
}

export function playerEnt(
  r: ReadCtx,
  vis: SeatVisibility,
  p: DeepReadonly<Read["players"][PlayerId]>,
  standing: Standing | undefined,
  army: UnitCounts | undefined,
): PlayerEnt {
  const units = sortedCounts(army ?? {});
  return {
    id: p.id,
    alive: p.alive,
    eliminatedAt: p.eliminatedAt,
    alliance: p.alliance,
    rank: standing?.rank ?? 1,
    score: standing?.score ?? 0,
    parts: { ...standing?.parts },
    cities: standing?.cities ?? 0,
    relations: relationsOf(r, p.id).map((x) => ({
      player: x.player,
      kind: x.kind,
      until: x.until,
    })),
    army: { pop: unitsPop(r.rules, units), units },
    ext: vis.publicPlayer(p.id),
  };
}

export function allianceEnt(a: DeepReadonly<Alliance>): Alliance {
  return { id: a.id, name: cleanText(a.name), members: [...a.members], formedAt: a.formedAt };
}

export function pactEnts(r: ReadCtx): FramePact[] {
  return r.state.pacts.map((p) => ({ a: p.a, b: p.b, since: p.since, expiresAt: p.expiresAt }));
}

/** Open proposals, in the order they were made. */
export function proposalEnts(r: ReadCtx): FrameProposal[] {
  return Object.values(r.state.proposals)
    .toSorted((a, b) => a.seq - b.seq)
    .map((p) => ({
      id: p.id,
      from: p.from,
      to: p.to,
      kind: p.kind,
      name: p.name === null ? null : cleanText(p.name),
      until: p.until,
      expiresAt: p.expiresAt,
    }));
}
