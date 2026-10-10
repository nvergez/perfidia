import type { Rng, WorldCtx, WorldSetup } from "@perfidia/engine/contracts";
import { randInt, rdiv, shuffle } from "@perfidia/engine/core";
import type {
  City,
  CityId,
  DeepReadonly,
  Island,
  IslandId,
  PlayerId,
  UnitCounts,
} from "@perfidia/protocol";
import {
  BUILDING_IDS,
  CROWN_TAG,
  homeRadius,
  type IslandKind,
  type PerfidiaConfig,
  RECRUIT_QUEUES,
} from "./config.ts";
import { initialExt, type PerfidiaExt } from "./ext.ts";
import { cosT, sinT } from "./sin10k.ts";

// Map generation and the starting state (perfidia-1 §2.3, §3). Pure: every draw comes from the
// named streams `map`, `seats` and `tiebreak`, each requested once.

/** The radial jitters of §2.3 step 2, drawn in this order. */
export interface Jitter {
  readonly backyard: number;
  readonly frontier: number;
  readonly inner: number;
  readonly hub: number;
}

/** What the `map` stream decides: the rotation in whole degrees and the jitters. */
export interface MapDraws {
  readonly rot: number;
  readonly jitter: Jitter;
}

/** An island of the layout with the sector it belongs to (`null` for the Crown). */
export interface LaidIsland extends Island {
  readonly kind: IslandKind;
  readonly sector: number | null;
}

/** The world timer that opens domination (§13.3). */
export const DOMINATION_OPEN = "domination_open";

/** Whether the map has a hub ring (N ≤ hubMaxPlayers, §2.1). */
export function hasHubs(config: DeepReadonly<PerfidiaConfig>, players: number): boolean {
  return players <= config.map.hubMaxPlayers;
}

/** Islands per sector: home, backyard, frontier, inner, and hub when there are hubs. */
export function islandsPerSector(config: DeepReadonly<PerfidiaConfig>, players: number): number {
  return hasHubs(config, players) ? 5 : 4;
}

/** The island id of a sector's island of a kind (§2.3 step 5); the Crown is `i1`. */
export function sectorIslandId(
  config: DeepReadonly<PerfidiaConfig>,
  players: number,
  sector: number,
  kind: Exclude<IslandKind, "crown">,
): IslandId {
  const offset = ["home", "backyard", "frontier", "inner", "hub"].indexOf(kind);
  if (kind === "hub" && !hasHubs(config, players)) {
    throw new RangeError(`N = ${players} has no hub islands`);
  }
  return `i${2 + sector * islandsPerSector(config, players) + offset}`;
}

/** §2.3 steps 1–2 on the `map` stream. The hub jitter is drawn even without hubs. */
export function drawMap(config: DeepReadonly<PerfidiaConfig>, rng: Rng): MapDraws {
  const rot = randInt(rng, 0, 359);
  const j = config.map.radialJitter;
  const backyard = randInt(rng, -j, j);
  const frontier = randInt(rng, -j, j);
  const inner = randInt(rng, -j, j);
  const hub = randInt(rng, -j, j);
  return { rot, jitter: { backyard, frontier, inner, hub } };
}

/** §2.3 steps 3–5: every island of the map, ids `i1..` in generation order. */
export function layoutIslands(
  config: DeepReadonly<PerfidiaConfig>,
  players: number,
  draws: MapDraws,
): LaidIsland[] {
  const R = homeRadius(config, players);
  const C = R + config.map.centerMargin;
  const radius = config.map.radius;
  const islands: LaidIsland[] = [];
  const add = (kind: IslandKind, sector: number | null, r: number, angle: number): void => {
    const k = config.map.kinds[kind];
    islands.push({
      id: `i${islands.length + 1}`,
      x: C + rdiv(r * cosT(angle), 10000),
      y: C + rdiv(r * sinT(angle), 10000),
      kind,
      slots: k.slots,
      richnessPm: k.richnessPm,
      sector,
    });
  };
  add("crown", null, 0, 0);
  const base = 10 * draws.rot;
  for (let k = 0; k < players; k += 1) {
    const A = base + Math.floor((3600 * k) / players);
    const M = base + Math.floor((3600 * (2 * k + 1)) / (2 * players));
    add("home", k, R, A);
    add("backyard", k, R + radius.backyardOffset + draws.jitter.backyard, A);
    add("frontier", k, R + radius.frontierOffset + draws.jitter.frontier, M);
    add("inner", k, R + radius.innerOffset + draws.jitter.inner, M);
    if (hasHubs(config, players)) add("hub", k, radius.hub + draws.jitter.hub, M);
  }
  return islands;
}

function stockSeconds(stock: { wood: number; stone: number; gold: number }, scale: number) {
  return { wood: stock.wood * scale, stone: stock.stone * scale, gold: stock.gold * scale };
}

/** A start city from a config seed (§3), with empty queues and every building listed. */
function seedCity(
  config: DeepReadonly<PerfidiaConfig>,
  seed: "capital" | "crown",
  id: CityId,
  island: IslandId,
  owner: PlayerId | null,
): City {
  const s = config.start[seed];
  const buildings: Record<string, number> = {};
  for (const b of BUILDING_IDS) buildings[b] = s.buildings[b];
  const recruit: City["recruit"] = {};
  for (const q of RECRUIT_QUEUES) recruit[q] = [];
  const units: UnitCounts = { ...s.units };
  return {
    id,
    name: id,
    owner,
    island,
    slot: 0,
    capitalOf: seed === "capital" ? owner : null,
    tag: seed === "crown" ? CROWN_TAG : null,
    foundedAt: 0,
    stock: stockSeconds(s.stock, config.economy.resourceScale),
    stockAt: 0,
    buildings,
    units,
    stationed: [],
    itemSeq: 0,
    build: [],
    recruit,
  };
}

/** Strips the layout-only `sector` field. */
function toIsland(i: LaidIsland): Island {
  return { id: i.id, x: i.x, y: i.y, kind: i.kind, slots: i.slots, richnessPm: i.richnessPm };
}

/**
 * `hooks.createWorld` (§2.3, §3): the islands, the capitals `c1..cN` in slot 0 of their seat's home
 * island, the neutral Crown `c(N+1)`, the public tie-break order, and the `domination_open` timer.
 */
export function createWorld(w: WorldCtx<PerfidiaConfig>): WorldSetup<PerfidiaExt> {
  const config = w.config;
  const N = w.players.length;
  const islands = layoutIslands(config, N, drawMap(config, w.rng("map")));
  const sectors = Array.from({ length: N }, (_, k) => k);
  const perm = shuffle(w.rng("seats"), sectors);
  const tiebreak = shuffle(w.rng("tiebreak"), w.players);
  const cities: City[] = w.players.map((p, j) => {
    const sector = perm[j];
    if (sector === undefined) throw new RangeError(`no sector for seat ${p}`);
    return seedCity(config, "capital", `c${j + 1}`, sectorIslandId(config, N, sector, "home"), p);
  });
  cities.push(seedCity(config, "crown", `c${N + 1}`, "i1", null));
  return {
    islands: islands.map(toIsland),
    cities,
    ext: initialExt(w.players, tiebreak),
    timers: [{ kind: DOMINATION_OPEN, at: config.time.dominationStart, ref: "" }],
  };
}
