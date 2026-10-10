import { assertSafeInt, cas, lossPm, mulDiv } from "@perfidia/engine/core";
import { allocateLosses } from "@perfidia/engine/std";
import type { DeepReadonly, PlayerId, Res, UnitCounts, UnitTable } from "@perfidia/protocol";

// Combat of sandbox-1 (docs/architecture.md §3.8) as pure functions over numbers: land only, one
// phase. `A = Σ attack` of the attacking land units; `D = Σ defense` of every land unit present
// that the attacker does not own, plus `keepDefense × keep`. Boats count in neither. `A > D` wins;
// ties go to the defender. The loser's land units all die; the winner loses `cas(n, q)` of each
// stack, `q = lossPm(loser, winner)`, a stack being one owner's units of one type, allocated over
// its groups with `std.allocateLosses`. The defender's boats sink when the defender loses; the
// attacker's boats always survive.

/** The unit tables of the compiled rules, in canonical order. */
type Units = readonly DeepReadonly<UnitTable>[];

/** One group of units on the defender side: the owner's units at home, or a stationed group. */
export interface DefenderGroup {
  /** `null`: a neutral city's garrison. */
  readonly owner: PlayerId | null;
  readonly units: Readonly<UnitCounts>;
}

export interface BattleInput {
  /** The attacking movement's units (boats included). */
  readonly attacker: Readonly<UnitCounts>;
  /** In allocation order: per owner, units at home first, then stationed groups (`std.stackGroups`). */
  readonly defenders: readonly DefenderGroup[];
  /** Completed keep level of the city. */
  readonly keep: number;
  /** Defense per keep level. */
  readonly keepDefense: number;
}

export interface BattleResult {
  /** A. */
  readonly attack: number;
  /** D, keep included. */
  readonly defense: number;
  readonly winner: "attacker" | "defender";
  /** Per-mille loss of each of the winner's land stacks. */
  readonly lossPm: number;
  /** Units the attacking movement loses. */
  readonly attackerLost: UnitCounts;
  /** Units each defender group loses, aligned with `BattleInput.defenders`. */
  readonly defenderLost: UnitCounts[];
}

function count(units: Readonly<UnitCounts>, id: string): number {
  const n = units[id] ?? 0;
  assertSafeInt(n, `count of ${id}`);
  if (n < 0) throw new RangeError(`count of ${id} must be ≥ 0, got ${n}`);
  return n;
}

/** `Σ count × stat(unit)` over the land units, in table order. */
function landSum(
  units: Units,
  counts: Readonly<UnitCounts>,
  stat: (u: DeepReadonly<UnitTable>) => number,
): number {
  let sum = 0;
  for (const u of units) {
    if (u.domain === "land") sum = assertSafeInt(sum + count(counts, u.id) * stat(u), "strength");
  }
  return sum;
}

/** A: Σ attack of the attacking land units. */
export function attackStrength(units: Units, attacker: Readonly<UnitCounts>): number {
  return landSum(units, attacker, (u) => u.attack);
}

/** D: Σ defense of the defending land units, plus `keepDefense × keep`. */
export function defenseStrength(
  units: Units,
  defenders: readonly DefenderGroup[],
  keep: number,
  keepDefense: number,
): number {
  let d = assertSafeInt(keepDefense * keep, "keep defense");
  for (const g of defenders) d = assertSafeInt(d + landSum(units, g.units, (u) => u.defense), "D");
  return d;
}

/** `lossPm(loser, winner)`, and 1000 when both are 0 (a tie: both sides are wiped out). */
export function winnerLossPm(loser: number, winner: number): number {
  return winner === 0 ? 1000 : lossPm(loser, winner);
}

/** Resolves one battle. Pure: the inputs are left untouched and every output is fresh. */
export function resolveBattle(units: Units, input: BattleInput): BattleResult {
  const a = attackStrength(units, input.attacker);
  const d = defenseStrength(units, input.defenders, input.keep, input.keepDefense);
  const attackerWins = a > d;
  const q = attackerWins ? winnerLossPm(d, a) : winnerLossPm(a, d);

  const attackerLost: UnitCounts = {};
  for (const u of units) {
    const n = count(input.attacker, u.id);
    if (n === 0 || u.domain !== "land") continue;
    const lost = attackerWins ? cas(n, q) : n;
    if (lost > 0) attackerLost[u.id] = lost;
  }

  const defenderLost: UnitCounts[] = input.defenders.map(() => ({}));
  if (!attackerWins) {
    // Each defending owner's land stacks lose cas(n, q), allocated over that owner's groups.
    const owners: (PlayerId | null)[] = [];
    for (const g of input.defenders) if (!owners.includes(g.owner)) owners.push(g.owner);
    for (const owner of owners) {
      const indices = input.defenders.flatMap((g, i) => (g.owner === owner ? [i] : []));
      for (const u of units) {
        if (u.domain !== "land") continue;
        const sizes = indices.map((i) => count(input.defenders[i]?.units ?? {}, u.id));
        const n = sizes.reduce((s, x) => s + x, 0);
        if (n === 0) continue;
        const shares = allocateLosses(sizes, cas(n, q));
        for (const [k, i] of indices.entries()) {
          const lost = shares[k] ?? 0;
          const into = defenderLost[i];
          if (lost > 0 && into !== undefined) into[u.id] = lost;
        }
      }
    }
  } else {
    // The defender loses everything in the city: land units and boats of every owner.
    for (const [i, g] of input.defenders.entries()) {
      const into = defenderLost[i];
      if (into === undefined) continue;
      for (const u of units) {
        const n = count(g.units, u.id);
        if (n > 0) into[u.id] = n;
      }
    }
  }
  return {
    attack: a,
    defense: d,
    winner: attackerWins ? "attacker" : "defender",
    lossPm: q,
    attackerLost,
    defenderLost,
  };
}

/** `units − lost`, without zero entries, in table order. */
export function survivorsOf(
  units: Units,
  before: Readonly<UnitCounts>,
  lost: Readonly<UnitCounts>,
): UnitCounts {
  const out: UnitCounts = {};
  for (const u of units) {
    const n = count(before, u.id) - count(lost, u.id);
    if (n < 0) throw new RangeError(`${u.id}: lost ${count(lost, u.id)} of ${count(before, u.id)}`);
    if (n > 0) out[u.id] = n;
  }
  return out;
}

/** Σ carry of the land units (boats carry no loot). */
export function carryOf(units: Units, counts: Readonly<UnitCounts>): number {
  return landSum(units, counts, (u) => u.carry);
}

/**
 * Raid loot (docs/architecture.md §3.8): `lootable_r = floor(stock_r × lootPm / 1000)` (half the
 * stock with the defaults), `T = Σ lootable`; when `T ≤ carry` everything lootable is taken,
 * otherwise `take_r = floor(lootable_r × carry / T)` and the leftover capacity is unused.
 */
export function lootTake(stock: Readonly<Res>, carry: number, lootPm: number): Res {
  assertSafeInt(carry, "carry");
  const lootable: Res = {
    wood: mulDiv(stock.wood, lootPm, 1000),
    stone: mulDiv(stock.stone, lootPm, 1000),
    gold: mulDiv(stock.gold, lootPm, 1000),
  };
  const total = lootable.wood + lootable.stone + lootable.gold;
  if (total <= carry) return lootable;
  return {
    wood: mulDiv(lootable.wood, carry, total),
    stone: mulDiv(lootable.stone, carry, total),
    gold: mulDiv(lootable.gold, carry, total),
  };
}
