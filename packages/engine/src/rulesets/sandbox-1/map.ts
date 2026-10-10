import type { Rng, WorldCtx, WorldSetup } from "@perfidia/engine/contracts";
import { shuffle } from "@perfidia/engine/core";
import type {
  City,
  CityId,
  DeepReadonly,
  Island,
  IslandId,
  PlayerId,
  UnitCounts,
} from "@perfidia/protocol";
import { HILL_OPEN } from "./compile.ts";
import {
  SANDBOX_BUILDINGS,
  SANDBOX_QUEUES,
  START_BUILDINGS,
  type SandboxConfig,
  type SandboxIslandKind,
} from "./config.ts";
import { initialExt, type SandboxExt } from "./ext.ts";

// Map generation and the starting state (docs/architecture.md §3.8). A ring of N sectors, each
// `sectorWidth` tiles wide (W = sectorWidth · N): sector k has a home island i(2k+1) at (40k, 0)
// and a shared island i(2k+2) at (40k + 20, 15) with the defaults. Distances wrap around the ring
// in x: d = min(dx, W − dx) + dy. Seats are a shuffle of the sectors on the stream `seats`; the
// only stream the world draws from.

/** A tile position. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** The ring's circumference in tiles, `W = sectorWidth · N`. */
export function ringWidth(config: DeepReadonly<SandboxConfig>, players: number): number {
  return config.map.sectorWidth * players;
}

/**
 * Ring distance in tiles: `min(dx, W − dx) + dy` with `dx = |xa − xb|`, `dy = |ya − yb|`. Every
 * island has `0 ≤ x < W` (the config keeps the shared island inside its sector), so it is ≥ 0.
 */
export function ringDistance(a: Point, b: Point, width: number): number {
  const dx = Math.abs(a.x - b.x);
  return Math.min(dx, width - dx) + Math.abs(a.y - b.y);
}

/** The island of a sector (0-based): home `i(2k+1)`, shared `i(2k+2)`. */
export function sectorIslandId(sector: number, kind: SandboxIslandKind): IslandId {
  return `i${2 * sector + (kind === "home" ? 1 : 2)}`;
}

/** The islands of the map in id order: per sector, its home island then its shared island. */
export function layoutIslands(config: DeepReadonly<SandboxConfig>, players: number): Island[] {
  const m = config.map;
  const out: Island[] = [];
  for (let k = 0; k < players; k += 1) {
    const x = m.sectorWidth * k;
    out.push({
      id: sectorIslandId(k, "home"),
      x,
      y: 0,
      kind: "home",
      slots: m.home.slots,
      richnessPm: m.home.richnessPm,
    });
    out.push({
      id: sectorIslandId(k, "shared"),
      x: x + m.shared.dx,
      y: m.shared.dy,
      kind: "shared",
      slots: m.shared.slots,
      richnessPm: m.shared.richnessPm,
    });
  }
  return out;
}

/** The seat draw: `perm = shuffle([0..N−1])`; player p(j+1) gets sector `perm[j]`. */
export function drawSectors(rng: Rng, players: number): number[] {
  return shuffle(
    rng,
    Array.from({ length: players }, (_, k) => k),
  );
}

/** A start city of `owner` in slot 0 of `island`, with the start buildings, stock and units. */
export function capitalCity(
  config: DeepReadonly<SandboxConfig>,
  id: CityId,
  owner: PlayerId,
  island: IslandId,
): City {
  const scale = config.economy.resourceScale;
  const stock = config.start.capitalStock * scale;
  const buildings: Record<string, number> = {};
  for (const b of SANDBOX_BUILDINGS) {
    buildings[b] = START_BUILDINGS.includes(b) ? config.start.level : 0;
  }
  const recruit: City["recruit"] = {};
  for (const q of SANDBOX_QUEUES) recruit[q] = [];
  const units: UnitCounts = config.start.spearmen > 0 ? { spearman: config.start.spearmen } : {};
  return {
    id,
    name: id,
    owner,
    island,
    slot: 0,
    capitalOf: owner,
    tag: null,
    foundedAt: 0,
    stock: { wood: stock, stone: stock, gold: stock },
    stockAt: 0,
    buildings,
    units,
    stationed: [],
    itemSeq: 0,
    build: [],
    recruit,
  };
}

/**
 * `hooks.createWorld`: the islands of `layoutIslands`, a capital `c(j+1)` for each player p(j+1) in
 * slot 0 of the home island of its drawn sector, no neutral city, `ext` with the hill closed, and
 * the `hill_open` world timer at `time.hillOpen`.
 */
export function createWorld(w: WorldCtx<SandboxConfig>): WorldSetup<SandboxExt> {
  const n = w.players.length;
  const islands = layoutIslands(w.config, n);
  const sectors = drawSectors(w.rng("seats"), n);
  const cities = w.players.map((p, j) => {
    const sector = sectors[j];
    if (sector === undefined) throw new RangeError(`no sector drawn for ${p}`);
    return capitalCity(w.config, `c${j + 1}`, p, sectorIslandId(sector, "home"));
  });
  return {
    islands,
    cities,
    ext: initialExt(),
    timers: [{ kind: HILL_OPEN, at: w.config.time.hillOpen, ref: "" }],
  };
}
