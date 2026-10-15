import {
  STANDARD_EVENT_DATA,
  type GameTime,
  type JsonObject,
  type LogLine,
  type PlayerId,
} from "@perfidia/protocol";
import type { MatchSummary } from "../summary/index.ts";
import type { BattleRecord } from "./battles.ts";
import { eliminations } from "./fights.ts";

// Per seat and per bot (docs/architecture.md §12.2). The score and its parts are the final
// standings' (perfidia-1 exposes `cityPoints` and `battleScore`, sandbox-1 `cityPoints` and
// `levelPoints`). A part the standings do not expose is derived from the log only: the prize points
// from the cities taken from no owner (`city_conquered` with `from: null`: the Crown of
// perfidia-1@1.0.0, Olympus from 1.1.0) still held at the end, times the header config's
// `scoring.crownBonus` (`scoring.olympusBonus` from 1.1.0); the building-level points as
// `cityPoints − scoring.cityBase × cities − prize points − scoring.conquestBonus × taken cities
// held` (the perfidia-1 §13.1 formula; a city is taken when its owner conquered it and never owned
// it before, 1.1.0 §13.3), only when the config has those keys and the seat is alive (an
// eliminated seat's score is frozen with its last city, §9.7, and is not split). Battle points are summed from the full battle reports'
// `points`. Cities founded, conquered (gained, retakes included) and lost come from the public
// `city_founded` and `city_conquered` events, eliminations from `player_eliminated`.

export interface SeatRow {
  readonly seat: PlayerId;
  /** The seat's controller at the end, without `bot:` (e.g. `rusher@2`). */
  readonly bot: string;
  readonly winner: boolean;
  /** From the final standings; null when the match did not end. */
  readonly rank: number | null;
  readonly score: number | null;
  /** The standings' score parts, as the ruleset names them. */
  readonly parts: Readonly<Record<string, number>>;
  readonly cityPoints: number | null;
  readonly levelPoints: number | null;
  readonly crownPoints: number | null;
  readonly battleScore: number | null;
  /** Battle points credited by the battles (before any cap); null when no report carries them. */
  readonly battlePoints: number | null;
  /** Cities at the end. */
  readonly cities: number | null;
  readonly founded: number;
  /** Cities taken by conquest (a retake of one's own city included). */
  readonly conquered: number;
  readonly lost: number;
  /** Cities taken from no owner (the Crown) held at the end. */
  readonly crowns: number;
  readonly eliminatedAt: GameTime | null;
  /** The seat that took its last city (`MatchRow.eliminatedBy`), or null. */
  readonly eliminatedBy: PlayerId | null;
  /** Seats it eliminated. */
  readonly eliminations: number;
}

/** A bot's seats over the ended runs of a variant (§12.2). */
export interface StrategyRow {
  /** A controller label without `bot:`, e.g. `conqueror@1`. */
  readonly bot: string;
  readonly seats: number;
  /** Seats among the winners (a bloc win counts for each of its seats). */
  readonly wins: number;
  /** `wins / seats`, to 3 decimals. */
  readonly winsPerSeat: number;
  /** The 95% Wilson score interval of `winsPerSeat`. */
  readonly winsPerSeatCi: readonly [number, number];
  /** Means per seat, over the seats that have the measure (null when none has it). */
  readonly score: number | null;
  readonly cityPoints: number | null;
  readonly levelPoints: number | null;
  readonly crownPoints: number | null;
  readonly battleScore: number | null;
  readonly battlePoints: number | null;
  readonly cities: number | null;
  readonly founded: number;
  readonly conquered: number;
  readonly lost: number;
  /** Totals over the seats. */
  readonly crowns: number;
  readonly eliminated: number;
  readonly inflicted: number;
}

const round2 = (x: number): number => Math.round(x * 100) / 100;
const round3 = (x: number): number => Math.round(x * 1000) / 1000;
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A controller label without its `bot:` prefix. */
export function botName(label: string): string {
  return label.startsWith("bot:") ? label.slice("bot:".length) : label;
}

/** An integer of the header config's `scoring` object, or null. */
function scoringValue(config: JsonObject, key: string): number | null {
  const scoring = Object.hasOwn(config, "scoring") ? config["scoring"] : undefined;
  if (typeof scoring !== "object" || scoring === null || Array.isArray(scoring)) return null;
  const v = Object.hasOwn(scoring, key) ? scoring[key] : undefined;
  return typeof v === "number" && Number.isSafeInteger(v) ? v : null;
}

const bump = (m: Map<string, number>, k: string, by = 1): void => {
  m.set(k, (m.get(k) ?? 0) + by);
};

/** The 95% Wilson score interval of `k` successes in `n` trials, to 3 decimals; `[0, 1]` when n = 0. */
export function wilson(k: number, n: number): [number, number] {
  if (n <= 0) return [0, 1];
  const z = 1.96;
  const z2 = z * z;
  const p = k / n;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [round3(Math.max(0, center - half)), round3(Math.min(1, center + half))];
}

/** One row per seat of a match, in seat order. */
export function seatRows(
  lines: readonly LogLine[],
  s: MatchSummary,
  battles: readonly BattleRecord[],
): SeatRow[] {
  const header = lines[0];
  const config = header?.k === "header" ? header.config : {};
  const cityBase = scoringValue(config, "cityBase");
  const crownBonus = scoringValue(config, "crownBonus") ?? scoringValue(config, "olympusBonus");
  const conquestBonus = scoringValue(config, "conquestBonus") ?? 0;
  const perLevel = scoringValue(config, "perBuildingLevel");

  const founded = new Map<string, number>();
  const conquered = new Map<string, number>();
  const lost = new Map<string, number>();
  const owner = new Map<string, PlayerId>();
  const formerOwners = new Map<string, Set<string>>();
  const ownerless = new Set<string>();
  for (const line of lines) {
    if (line.k !== "ev") continue;
    if (line.e.type === "city_founded") {
      const f = STANDARD_EVENT_DATA.city_founded.safeParse(line.e.data);
      if (f.success) bump(founded, f.data.owner);
    } else if (line.e.type === "city_conquered") {
      const c = STANDARD_EVENT_DATA.city_conquered.safeParse(line.e.data);
      if (!c.success) continue;
      bump(conquered, c.data.to);
      if (c.data.from === null) ownerless.add(c.data.city);
      else {
        bump(lost, c.data.from);
        const former = formerOwners.get(c.data.city) ?? new Set<string>();
        former.add(c.data.from);
        formerOwners.set(c.data.city, former);
      }
      owner.set(c.data.city, c.data.to);
    }
  }
  const crowns = new Map<string, number>();
  for (const city of ownerless) {
    const o = owner.get(city);
    if (o !== undefined) bump(crowns, o);
  }
  const taken = new Map<string, number>();
  for (const [city, o] of owner) {
    if (!(formerOwners.get(city)?.has(o) ?? false)) bump(taken, o);
  }
  const elims = eliminations(lines);
  const inflicted = new Map<string, number>();
  for (const e of elims) if (e.by !== null) bump(inflicted, e.by);
  const pointsKnown = battles.length === 0 || battles.some((b) => b.points !== null);
  const points = new Map<string, number>();
  for (const b of battles) for (const p of b.points ?? []) bump(points, p.player, p.points);

  return s.seats.map((x): SeatRow => {
    const alive = x.alive === true;
    const part = (k: string): number | null =>
      Object.hasOwn(x.parts, k) ? (x.parts[k] ?? null) : null;
    const cityPoints = part("cityPoints");
    const held = crowns.get(x.seat) ?? 0;
    const crownPoints =
      part("crownPoints") ?? (alive && crownBonus !== null ? crownBonus * held : null);
    const derivable =
      alive && cityPoints !== null && x.cities !== null && cityBase !== null && perLevel !== null;
    const levelPoints =
      part("levelPoints") ??
      (derivable && crownPoints !== null
        ? cityPoints -
          cityBase * (x.cities ?? 0) -
          crownPoints -
          conquestBonus * (taken.get(x.seat) ?? 0)
        : null);
    return {
      seat: x.seat,
      bot: botName(x.controllers.at(-1)?.label ?? ""),
      winner: s.winners.includes(x.seat),
      rank: x.rank,
      score: x.score,
      parts: x.parts,
      cityPoints,
      levelPoints,
      crownPoints,
      battleScore: part("battleScore"),
      battlePoints: pointsKnown ? (points.get(x.seat) ?? 0) : null,
      cities: x.cities,
      founded: founded.get(x.seat) ?? 0,
      conquered: conquered.get(x.seat) ?? 0,
      lost: lost.get(x.seat) ?? 0,
      crowns: held,
      eliminatedAt: x.eliminatedAt,
      eliminatedBy: elims.find((e) => e.player === x.seat)?.by ?? null,
      eliminations: inflicted.get(x.seat) ?? 0,
    };
  });
}

/** Mean of the non-null values (2 decimals), null when there is none. */
function meanOf(xs: readonly (number | null)[]): number | null {
  const had = xs.filter((x): x is number => x !== null);
  return had.length === 0 ? null : round2(had.reduce((a, b) => a + b, 0) / had.length);
}

/** One row per bot over the seats of ended runs, by label. */
export function strategyRows(
  matches: readonly { readonly status: string; readonly seats: readonly SeatRow[] }[],
): StrategyRow[] {
  const byBot = new Map<string, SeatRow[]>();
  for (const m of matches) {
    if (m.status !== "ended") continue;
    for (const seat of m.seats) {
      const list = byBot.get(seat.bot) ?? [];
      list.push(seat);
      byBot.set(seat.bot, list);
    }
  }
  return [...byBot.keys()].toSorted(byCodeUnit).map((bot): StrategyRow => {
    const seats = byBot.get(bot) ?? [];
    const n = seats.length;
    const wins = seats.filter((x) => x.winner).length;
    const avg = (f: (x: SeatRow) => number | null): number | null => meanOf(seats.map(f));
    const sum = (f: (x: SeatRow) => number): number => seats.reduce((a, x) => a + f(x), 0);
    return {
      bot,
      seats: n,
      wins,
      winsPerSeat: n === 0 ? 0 : round3(wins / n),
      winsPerSeatCi: wilson(wins, n),
      score: avg((x) => x.score),
      cityPoints: avg((x) => x.cityPoints),
      levelPoints: avg((x) => x.levelPoints),
      crownPoints: avg((x) => x.crownPoints),
      battleScore: avg((x) => x.battleScore),
      battlePoints: avg((x) => x.battlePoints),
      cities: avg((x) => x.cities),
      founded: avg((x) => x.founded) ?? 0,
      conquered: avg((x) => x.conquered) ?? 0,
      lost: avg((x) => x.lost) ?? 0,
      crowns: sum((x) => x.crowns),
      eliminated: seats.filter((x) => x.eliminatedAt !== null).length,
      inflicted: sum((x) => x.eliminations),
    };
  });
}
