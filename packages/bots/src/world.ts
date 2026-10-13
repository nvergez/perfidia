// What a bot knows during one turn: the briefing, the rules kit and the views it read this turn,
// assembled into one read-only model that the strategies plan from (docs/architecture.md §11.1).

import {
  compareIds,
  type Briefing,
  type BuildingId,
  type CityId,
  type CityView,
  type CityViewFull,
  type IslandId,
  type LeaderboardView,
  type MapView,
  type PlayerId,
  type PlayerView,
  type QueueId,
  type Res,
  type UnitCounts,
  type UnitId,
} from "@perfidia/protocol";
import type { StrategyHints } from "./hints.ts";
import { dayOf, pickTravel, resOfTriple, type Kit } from "./kit.ts";
import type { Memory } from "./memory.ts";

export interface QueuedBuild {
  readonly item: number;
  readonly building: BuildingId;
  readonly level: number;
  readonly end: number;
}

export interface QueuedBatch {
  readonly item: number;
  readonly unit: UnitId;
  readonly count: number;
  readonly end: number;
}

/** An own city: the briefing's numbers plus the completed levels of `view_city`. */
export interface OwnCity {
  readonly id: CityId;
  readonly island: IslandId;
  readonly capital: boolean;
  /** Whole units. */
  readonly res: Res;
  /** Per game hour. */
  readonly rate: Res;
  readonly cap: number;
  readonly popUsed: number;
  readonly popCap: number;
  /** Completed building levels; `null` when the city was not viewed this turn. */
  readonly levels: Readonly<Record<BuildingId, number>> | null;
  readonly build: readonly QueuedBuild[];
  readonly recruit: Readonly<Record<QueueId, readonly QueuedBatch[]>>;
  /** The owner's units at home. */
  readonly units: Readonly<UnitCounts>;
  /** A ruleset state that stops the city from acting (hints, e.g. a siege). */
  readonly blocked: boolean;
}

/** A city of another owner (or neutral), from `view_map`. */
export interface OtherCity {
  readonly id: CityId;
  readonly island: IslandId;
  readonly slot: number;
  readonly owner: PlayerId | null;
  readonly capitalOf: PlayerId | null;
}

export interface World {
  readonly seat: PlayerId;
  readonly turn: number;
  /** The latest game time the bot knows of (briefing or results). */
  readonly t: number;
  /** Game day index, from 0. */
  readonly day: number;
  readonly briefing: Briefing;
  readonly kit: Kit;
  readonly hints: StrategyHints;
  readonly memory: Memory;
  /** Own cities, by id. */
  readonly cities: readonly OwnCity[];
  /** `view_player` on itself, when read. */
  readonly self: PlayerView | null;
  readonly map: MapView | null;
  /** Other players' and neutral cities, by id (empty without a map). */
  readonly others: readonly OtherCity[];
  /** Every `view_city` read this turn. */
  readonly views: ReadonlyMap<CityId, CityView>;
  readonly board: LeaderboardView | null;
  /** The seat's relations (from `view_player` on itself). */
  readonly relations: ReadonlyMap<PlayerId, "ally" | "pact">;
  /** Travel time from an own city to an island (`spy`: the spy probe), or null when unknown. */
  travel(from: CityId, island: IslandId, spy: boolean): number | null;
  /** The travel times from an own city to an island, one per probe (`view_map`), or null when unknown. */
  travelRow(from: CityId, island: IslandId): readonly number[] | null;
}

export interface Reads {
  self: PlayerView | null;
  map: MapView | null;
  readonly views: Map<CityId, CityView>;
  board: LeaderboardView | null;
}

export function emptyReads(): Reads {
  return { self: null, map: null, views: new Map(), board: null };
}

function fullView(v: CityView | undefined): CityViewFull | null {
  return v !== undefined && v.access === "full" ? v : null;
}

export interface WorldInput {
  readonly seat: PlayerId;
  readonly turn: number;
  readonly t: number;
  readonly briefing: Briefing;
  readonly kit: Kit;
  readonly hints: StrategyHints;
  readonly memory: Memory;
  readonly reads: Reads;
  /** Cached travel rows: own city → island → seconds per probe. */
  readonly travel: ReadonlyMap<CityId, Readonly<Record<string, readonly number[]>>>;
}

export function buildWorld(i: WorldInput): World {
  const { briefing, kit, hints, reads, seat } = i;
  const cities: OwnCity[] = briefing.cities
    .map((c): OwnCity => {
      const view = fullView(reads.views.get(c.id));
      const ext = c.ext ?? {};
      const recruit: Record<QueueId, QueuedBatch[]> = {};
      for (const [q, batches] of Object.entries(c.recruit)) {
        recruit[q] = batches.map((b) => ({
          item: b.item,
          unit: b.unit,
          count: b.n,
          end: b.end[0],
        }));
      }
      return {
        id: c.id,
        island: c.isl,
        capital: view !== null ? view.capitalOf === seat : false,
        res: resOfTriple(c.res),
        rate: resOfTriple(c.rate),
        cap: c.cap,
        popUsed: c.pop[0],
        popCap: c.pop[1],
        levels: view === null ? null : view.buildings,
        build: c.build.map((b) => ({ item: b.item, building: b.b, level: b.lvl, end: b.end[0] })),
        recruit,
        units: c.units,
        blocked: hints.blockedExt.some((key) => Object.hasOwn(ext, key)),
      };
    })
    .toSorted((a, b) => compareIds(a.id, b.id));

  const own = new Set(cities.map((c) => c.id));
  const others: OtherCity[] =
    reads.map === null
      ? []
      : reads.map.cities
          .filter((c) => !own.has(c.id) && c.owner !== seat)
          .map((c) => ({
            id: c.id,
            island: c.island,
            slot: c.slot,
            owner: c.owner,
            capitalOf: c.capitalOf,
          }))
          .toSorted((a, b) => compareIds(a.id, b.id));

  // A capital the views did not mark: the map's `capitalOf`.
  if (reads.map !== null) {
    const capitals = new Set(
      reads.map.cities.filter((c) => c.capitalOf === seat).map((c) => c.id as string),
    );
    for (const [n, c] of cities.entries()) {
      if (!c.capital && capitals.has(c.id)) cities[n] = { ...c, capital: true };
    }
  }

  const relations = new Map<PlayerId, "ally" | "pact">();
  for (const r of reads.self?.relations ?? []) {
    if (r.player !== seat && !relations.has(r.player)) relations.set(r.player, r.kind);
  }

  return {
    seat,
    turn: i.turn,
    t: i.t,
    day: dayOf(i.t),
    briefing,
    kit,
    hints,
    memory: i.memory,
    cities,
    self: reads.self,
    map: reads.map,
    others,
    views: reads.views,
    board: reads.board,
    relations,
    travel(from: CityId, island: IslandId, spy: boolean): number | null {
      const row = i.travel.get(from)?.[island];
      return row === undefined ? null : pickTravel(kit, row, spy);
    },
    travelRow(from: CityId, island: IslandId): readonly number[] | null {
      return i.travel.get(from)?.[island] ?? null;
    },
  };
}

// Queries over a world.

/** The free slot numbers of `island`, from the map (none without a map). */
export function freeSlots(w: World, island: IslandId): number[] {
  const isl = w.map?.islands.find((x) => x.id === island);
  if (isl === undefined || w.map === null) return [];
  const used = new Set(w.map.cities.filter((c) => c.island === island).map((c) => c.slot));
  const out: number[] = [];
  for (let s = 0; s < isl.slots; s += 1) if (!used.has(s)) out.push(s);
  return out;
}
