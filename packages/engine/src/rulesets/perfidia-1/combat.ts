import { cas, clamp, lossPm, mulDiv } from "@perfidia/engine/core";
import { compareIds, type DeepReadonly, type Res } from "@perfidia/protocol";
import { type PerfidiaConfig, quad } from "./config.ts";

// Combat maths of perfidia-1 §8 as pure functions over numbers: morale, the naval phase, the land
// phase, losses (split stacks included), loot and the battle-point split. No state is read or
// written here: the `arrive.attack` hook gathers the participants and applies the result.

/** The owner label of the Crown's neutral garrison in combat stacks. */
export const NEUTRAL = "neutral";

/** The combat stats of a unit type. */
export interface UnitStats {
  readonly domain: "land" | "naval";
  readonly attack: number;
  readonly defense: number;
  readonly naval: number;
  readonly carry: number;
  readonly pop: number;
}

/**
 * One stack: the units of one owner and one type (§8.3), split into the groups they sit in (the
 * owner's units at home first, then stationed groups by home city, then role). An attacking stack
 * has one group: the movement.
 */
export interface CombatStack {
  /** A player id, or `"neutral"` for the Crown's garrison. */
  readonly owner: string;
  readonly unit: string;
  /** Units per group; their sum is the stack size. */
  readonly groups: readonly number[];
}

/** City battle (§8), relief battle against a garrison, or homecoming battle (§9.3). */
export type BattleKind = "city" | "relief" | "homecoming";

export interface BattleInput {
  readonly kind: BattleKind;
  /** Morale in per mille (§8.2). */
  readonly moralePm: number;
  /** The movement's departure island differs from the city's: the naval phase runs (§8.1). */
  readonly acrossWater: boolean;
  readonly attacker: readonly CombatStack[];
  readonly defender: readonly CombatStack[];
  /** Completed hall level of the city (base defense). */
  readonly hall: number;
  /** Wall level of the city. */
  readonly wall: number;
}

export type Side = "attacker" | "defender";

/** A stack's counts per group before the battle, lost, and surviving. */
export interface StackOutcome {
  readonly owner: string;
  readonly unit: string;
  readonly before: readonly number[];
  readonly lost: readonly number[];
  readonly survived: readonly number[];
}

export interface NavalPhase {
  /** `floor(Σ naval of attacking warships × m / 1000)`. */
  readonly Na: number;
  /** `Σ naval of defending warships`. */
  readonly Nd: number;
  readonly winner: Side;
  /** Loss rate of the winner's warships, per mille. */
  readonly q: number;
}

export interface LandPhase {
  /** `floor(Σ attack of attacking land units × m / 1000)`. */
  readonly A: number;
  readonly D: number;
  /** The parts of D: Σ defense of defending land units, base defense, wall factor (‰). */
  readonly sumDefense: number;
  readonly baseDefense: number;
  readonly wallPm: number;
  readonly winner: Side;
  /** Loss rate of the winner's land stacks, per mille. */
  readonly q: number;
}

export interface BattleResult {
  readonly kind: BattleKind;
  readonly moralePm: number;
  /** `null` when the naval phase did not run (same island, or Na = Nd = 0). */
  readonly naval: NavalPhase | null;
  /** `null` when the land phase did not run (lost naval phase, or no attacking land unit). */
  readonly land: LandPhase | null;
  /** The winner of the last phase that ran; the defender when none ran. */
  readonly winner: Side;
  /** The attacker won the land phase: a city battle then breaches the wall (§8.6). */
  readonly attackerWonLand: boolean;
  readonly attacker: readonly StackOutcome[];
  readonly defender: readonly StackOutcome[];
}

export type StatsTable = Readonly<Record<string, UnitStats>>;

/** The combat stats of the config's units. */
export function statsOf(config: DeepReadonly<PerfidiaConfig>): StatsTable {
  const out: Record<string, UnitStats> = {};
  for (const [id, u] of Object.entries(config.units)) {
    out[id] = {
      domain: u.domain,
      attack: u.attack,
      defense: u.defense,
      naval: u.naval,
      carry: u.carry,
      pop: u.pop,
    };
  }
  return out;
}

/**
 * Morale in per mille (§8.2): `clamp(1000 − moralePmPerCity × (attacker's cities − foe's cities),
 * moraleFloorPm, 1000)`; 1000 against the neutral Crown (`foeCities` null).
 */
export function moralePm(
  config: DeepReadonly<PerfidiaConfig>,
  attackerCities: number,
  foeCities: number | null,
): number {
  if (foeCities === null) return 1000;
  const c = config.combat;
  return clamp(1000 - c.moralePmPerCity * (attackerCities - foeCities), c.moraleFloorPm, 1000);
}

/** Base defense of a city with hall level H (§4.1): `20H + 50` by default. */
export function baseDefense(config: DeepReadonly<PerfidiaConfig>, hall: number): number {
  return quad(config.economy.baseDefense, hall);
}

/** Wall factor in per mille (§4.1): `1000 + 50 · wall`. */
export function wallFactorPm(config: DeepReadonly<PerfidiaConfig>, wall: number): number {
  return 1000 + config.combat.wallPmPerLevel * wall;
}

/** The wall after a lost city battle (§8.6): one level lower by default, never below 0. */
export function wallAfterBreach(config: DeepReadonly<PerfidiaConfig>, wall: number): number {
  return Math.max(0, wall - config.combat.wallBreachOnLoss);
}

/** Whether a won conquest may start a siege (§8.6, §9.5): not on a capital before immunity ends. */
export function canBesiege(
  config: DeepReadonly<PerfidiaConfig>,
  isCapital: boolean,
  now: number,
): boolean {
  return !isCapital || now >= config.time.capitalImmunityEnd;
}

function statOf(stats: StatsTable, unit: string): UnitStats {
  const s = stats[unit];
  if (s === undefined) throw new RangeError(`no combat stats for unit ${unit}`);
  return s;
}

function sum(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

/**
 * Splits `loss` units over groups of `sizes` by largest remainder (§8.3): group i first loses
 * `floor(loss · g_i / n)`, then the remaining losses go one per group in descending order of
 * `(loss · g_i) mod n`, ties to the earlier group. Needs 0 ≤ loss ≤ n = Σ sizes.
 */
export function splitLosses(sizes: readonly number[], loss: number): number[] {
  const n = sum(sizes);
  if (!Number.isSafeInteger(loss) || loss < 0 || loss > n) {
    throw new RangeError(`cannot lose ${loss} units out of ${n}`);
  }
  if (n === 0) return sizes.map(() => 0);
  const out = sizes.map((g) => mulDiv(loss, g, n));
  let left = loss - sum(out);
  const order = sizes
    .map((g, i) => ({ i, rem: (loss * g) % n }))
    .toSorted((a, b) => b.rem - a.rem || a.i - b.i);
  for (const { i } of order) {
    if (left === 0) break;
    out[i] = (out[i] ?? 0) + 1;
    left -= 1;
  }
  return out;
}

/** Mutable working copy of a stack during a battle. */
interface Working {
  readonly owner: string;
  readonly unit: string;
  readonly stats: UnitStats;
  readonly before: readonly number[];
  alive: number[];
  lost: number[];
}

function working(stats: StatsTable, stacks: readonly CombatStack[]): Working[] {
  return stacks.map((s) => {
    for (const g of s.groups) {
      if (!Number.isSafeInteger(g) || g < 0) {
        throw new RangeError(`stack ${s.owner}/${s.unit} has an invalid group size ${g}`);
      }
    }
    return {
      owner: s.owner,
      unit: s.unit,
      stats: statOf(stats, s.unit),
      before: [...s.groups],
      alive: [...s.groups],
      lost: s.groups.map(() => 0),
    };
  });
}

const size = (w: Working): number => sum(w.alive);

/** The stack loses `cas(n, q)` units, allocated over its groups. */
function takeCasualties(w: Working, q: number): void {
  kill(w, splitLosses(w.alive, cas(size(w), q)));
}

function wipe(w: Working): void {
  kill(w, w.alive);
}

function kill(w: Working, perGroup: readonly number[]): void {
  w.lost = w.lost.map((l, i) => l + (perGroup[i] ?? 0));
  w.alive = w.alive.map((g, i) => g - (perGroup[i] ?? 0));
}

function outcome(w: Working): StackOutcome {
  return {
    owner: w.owner,
    unit: w.unit,
    before: w.before,
    lost: [...w.lost],
    survived: [...w.alive],
  };
}

/** `Σ stat × n` over stacks. */
function strength(stacks: readonly Working[], stat: (s: UnitStats) => number): number {
  let total = 0;
  for (const w of stacks) total += stat(w.stats) * size(w);
  return total;
}

/** Morale-scaled attacking land strength `A` (§8.5) of unit counts, for previews and properties. */
export function landAttack(
  stats: StatsTable,
  units: Readonly<Record<string, number>>,
  morale: number,
): number {
  let total = 0;
  for (const [unit, n] of Object.entries(units)) {
    const s = statOf(stats, unit);
    if (s.domain === "land") total += s.attack * n;
  }
  return mulDiv(total, morale, 1000);
}

/** `D = floor((Σ defense + baseDef(hall)) × (1000 + 50·wall) / 1000)` (§8.5). */
export function landDefense(
  config: DeepReadonly<PerfidiaConfig>,
  sumDefense: number,
  hall: number,
  wall: number,
): number {
  return mulDiv(sumDefense + baseDefense(config, hall), wallFactorPm(config, wall), 1000);
}

const isNaval = (w: Working): boolean => w.stats.domain === "naval";
const isLand = (w: Working): boolean => w.stats.domain === "land";
/** Warships: naval units with a naval strength. Transports are naval but never fight. */
const fightsAtSea = (w: Working): boolean => isNaval(w) && w.stats.naval > 0;

/**
 * Resolves one battle (§8.1–8.5, §9.3): morale, then the naval phase across water, then the land
 * phase if the attacker still has land units (a homecoming always runs it). Wall breach, loot,
 * sieges and battle points are applied by the caller from the result.
 */
export function resolveBattle(
  config: DeepReadonly<PerfidiaConfig>,
  input: BattleInput,
): BattleResult {
  const stats = statsOf(config);
  const m = input.moralePm;
  const att = working(stats, input.attacker);
  const def = working(stats, input.defender);

  let naval: NavalPhase | null = null;
  if (input.acrossWater) {
    const Na = mulDiv(
      strength(att.filter(fightsAtSea), (s) => s.naval),
      m,
      1000,
    );
    const Nd = strength(def.filter(fightsAtSea), (s) => s.naval);
    if (Na > Nd) {
      const q = lossPm(Nd, Na);
      for (const w of att.filter(fightsAtSea)) takeCasualties(w, q);
      for (const w of def.filter(isNaval)) wipe(w);
      naval = { Na, Nd, winner: "attacker", q };
    } else if (Nd > 0) {
      const q = lossPm(Na, Nd);
      for (const w of att) wipe(w);
      for (const w of def.filter(fightsAtSea)) takeCasualties(w, q);
      naval = { Na, Nd, winner: "defender", q };
    }
  }

  let land: LandPhase | null = null;
  const navalLost = naval !== null && naval.winner === "defender";
  const hasLand = att.some((w) => isLand(w) && size(w) > 0);
  if (!navalLost && (hasLand || input.kind === "homecoming")) {
    const A = mulDiv(
      strength(att.filter(isLand), (s) => s.attack),
      m,
      1000,
    );
    const sumDefense = strength(def.filter(isLand), (s) => s.defense);
    const base = baseDefense(config, input.hall);
    const wallPm = wallFactorPm(config, input.wall);
    const D = mulDiv(sumDefense + base, wallPm, 1000);
    if (A > D) {
      const q = lossPm(D, A);
      for (const w of att.filter(isLand)) takeCasualties(w, q);
      for (const w of def) wipe(w);
      land = { A, D, sumDefense, baseDefense: base, wallPm, winner: "attacker", q };
    } else {
      // An exact tie (A = D, including 0 = 0) costs the defender q = 1000 (§8.3).
      const q = D === 0 ? 1000 : lossPm(A, D);
      for (const w of att) {
        if (isLand(w) || input.kind === "homecoming") wipe(w);
      }
      for (const w of def.filter(isLand)) takeCasualties(w, q);
      land = { A, D, sumDefense, baseDefense: base, wallPm, winner: "defender", q };
    }
  }

  const winner: Side = land?.winner ?? naval?.winner ?? "defender";
  return {
    kind: input.kind,
    moralePm: m,
    naval,
    land,
    winner,
    attackerWonLand: land?.winner === "attacker",
    attacker: att.map(outcome),
    defender: def.map(outcome),
  };
}

/** Units surviving on a side, summed over groups, by unit type. */
export function survivorsOf(stacks: readonly StackOutcome[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of stacks) {
    const n = sum(s.survived);
    if (n > 0) out[s.unit] = (out[s.unit] ?? 0) + n;
  }
  return out;
}

/** Carry capacity of surviving attacking units (§8.7): `Σ carry × n` over land units. */
export function carryOf(stats: StatsTable, units: Readonly<Record<string, number>>): number {
  let total = 0;
  for (const [unit, n] of Object.entries(units)) {
    const s = statOf(stats, unit);
    if (s.domain === "land") total += s.carry * n;
  }
  return total;
}

/**
 * Loot (§8.7): `lootable_r = max(0, stock_r − lootProtectPerLevel × warehouse)`; everything
 * lootable when it fits in `carry`, otherwise `floor(lootable_r × carry / T)` of each resource.
 */
export function lootOf(
  config: DeepReadonly<PerfidiaConfig>,
  stock: DeepReadonly<Res>,
  warehouse: number,
  carry: number,
): Res {
  const protect = config.economy.lootProtectPerLevel * warehouse;
  const lootable: Res = {
    wood: Math.max(0, stock.wood - protect),
    stone: Math.max(0, stock.stone - protect),
    gold: Math.max(0, stock.gold - protect),
  };
  const total = lootable.wood + lootable.stone + lootable.gold;
  if (total <= carry) return lootable;
  return {
    wood: mulDiv(lootable.wood, carry, total),
    stone: mulDiv(lootable.stone, carry, total),
    gold: mulDiv(lootable.gold, carry, total),
  };
}

/** Pop of every unit lost on a side, by owner (sorted by owner). */
export function popLostByOwner(
  stats: StatsTable,
  stacks: readonly StackOutcome[],
): { owner: string; pop: number }[] {
  return popByOwner(stats, stacks, (s) => sum(s.lost));
}

/** Pop of every unit on a side at the start of the battle, by owner (sorted by owner). */
export function popBeforeByOwner(
  stats: StatsTable,
  stacks: readonly StackOutcome[],
): { owner: string; pop: number }[] {
  return popByOwner(stats, stacks, (s) => sum(s.before));
}

function popByOwner(
  stats: StatsTable,
  stacks: readonly StackOutcome[],
  count: (s: StackOutcome) => number,
): { owner: string; pop: number }[] {
  const byOwner: Record<string, number> = {};
  for (const s of stacks) {
    byOwner[s.owner] = (byOwner[s.owner] ?? 0) + statOf(stats, s.unit).pop * count(s);
  }
  return Object.keys(byOwner)
    .toSorted(compareIds)
    .map((owner) => ({ owner, pop: byOwner[owner] ?? 0 }));
}

/** Battle points of one battle before the anti-collusion rule (§8.8). */
export interface BattleCredit {
  /** Pop of the defending units the attacker destroyed, per defending owner (ships included). */
  readonly attackerByOwner: readonly { owner: string; pop: number }[];
  /** The pop of attacking units destroyed, split among defending owners by their pop at the start. */
  readonly defenders: readonly { owner: string; points: number }[];
}

/**
 * The battle-point split of §8.8. Defender credit is `floor(killed × ownerPop / totalDefenderPop)`;
 * with no defending pop, everything goes to `fallbackOwner` (the city owner, or the besieger in a
 * garrison battle). The neutral owner (`"neutral"` or a null fallback) earns nothing. The caller
 * drops the credit between related players (anti-collusion) and adds it to `ext.battlePoints`.
 */
export function battleCredit(
  stats: StatsTable,
  result: BattleResult,
  fallbackOwner: string | null,
): BattleCredit {
  const attackerByOwner = popLostByOwner(stats, result.defender).filter((e) => e.pop > 0);
  const killed = sum(popLostByOwner(stats, result.attacker).map((e) => e.pop));
  const pops = popBeforeByOwner(stats, result.defender);
  const totalPop = sum(pops.map((e) => e.pop));
  const defenders: { owner: string; points: number }[] = [];
  if (killed > 0) {
    if (totalPop === 0) {
      if (fallbackOwner !== null && fallbackOwner !== NEUTRAL) {
        defenders.push({ owner: fallbackOwner, points: killed });
      }
    } else {
      for (const e of pops) {
        if (e.owner === NEUTRAL) continue;
        const points = mulDiv(killed, e.pop, totalPop);
        if (points > 0) defenders.push({ owner: e.owner, points });
      }
    }
  }
  return { attackerByOwner, defenders };
}
