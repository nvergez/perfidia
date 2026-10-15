import { ceilDiv } from "@perfidia/engine/core";
import {
  compareIds,
  type AllianceId,
  type DeepReadonly,
  type GameState,
  type PlayerId,
} from "@perfidia/protocol";
import type { PerfidiaCore } from "./config.ts";
import type { BlocKey } from "./ext.ts";

// Domination (perfidia-1 §13.3): blocs, qualification and the order of countdowns ending in the
// same second. The timer flag, countdown bookkeeping and the win itself are the hooks' (T11).

/** A bloc: an alliance with its current members, or a player outside any alliance. */
export interface Bloc {
  readonly key: BlocKey;
  readonly alliance: AllianceId | null;
  /** Sorted. */
  readonly members: readonly PlayerId[];
}

/**
 * Every bloc of the state in bloc order (§13.3): alliances by id, then alive players outside any
 * alliance by id (`compareIds`). Eliminated players form no bloc.
 */
export function blocsOf(state: DeepReadonly<GameState>): Bloc[] {
  const alliances = Object.values(state.alliances)
    .map((a) => ({ key: a.id, alliance: a.id, members: a.members.toSorted(compareIds) }))
    .toSorted((a, b) => compareIds(a.key, b.key));
  const lone = Object.values(state.players)
    .filter((p) => p.alive && p.alliance === null)
    .map((p) => ({ key: p.id, alliance: null, members: [p.id] }))
    .toSorted((a, b) => compareIds(a.key, b.key));
  return [...alliances, ...lone];
}

/** Every city of the state, the neutral Crown included. */
export function totalCities(state: DeepReadonly<GameState>): number {
  return Object.keys(state.cities).length;
}

/** Cities owned by the members of a bloc; a besieged city counts for its owner. */
export function blocCities(state: DeepReadonly<GameState>, members: readonly PlayerId[]): number {
  let n = 0;
  for (const city of Object.values(state.cities)) {
    if (city.owner !== null && members.includes(city.owner)) n += 1;
  }
  return n;
}

/** The cities a bloc needs: `max(2N, ceilDiv(400 × totalCities, 1000))` (§13.3). */
export function dominationThreshold(
  config: DeepReadonly<PerfidiaCore>,
  players: number,
  total: number,
): number {
  const v = config.victory;
  return Math.max(v.dominationMinPerPlayer * players, ceilDiv(v.dominationPm * total, 1000));
}

/** Whether a bloc qualifies (from the domination opening on, which the hooks track). */
export function qualifies(
  config: DeepReadonly<PerfidiaCore>,
  players: number,
  total: number,
  cities: number,
): boolean {
  return cities >= dominationThreshold(config, players, total);
}

/** A countdown ending this second, with what orders it against the others. */
export interface EndingCountdown {
  readonly bloc: BlocKey;
  readonly cities: number;
  /** Total score of the bloc's members. */
  readonly score: number;
  /** Best (lowest) tie-break position among the members. */
  readonly bestTiebreak: number;
}

/**
 * Countdowns ending in the same second, in resolution order (§13.3): more cities, then higher total
 * score, then the best tie-break position among the members.
 */
export function orderEndingCountdowns(ending: readonly EndingCountdown[]): BlocKey[] {
  return ending
    .toSorted(
      (a, b) =>
        b.cities - a.cities ||
        b.score - a.score ||
        a.bestTiebreak - b.bestTiebreak ||
        compareIds(a.bloc, b.bloc),
    )
    .map((c) => c.bloc);
}

/** The best (lowest) tie-break position among `members`. */
export function bestTiebreak(tiebreak: readonly PlayerId[], members: readonly PlayerId[]): number {
  let best = Number.MAX_SAFE_INTEGER;
  for (const p of members) {
    const i = tiebreak.indexOf(p);
    if (i < 0) throw new RangeError(`${p} is not in the tie-break order`);
    best = Math.min(best, i);
  }
  return best;
}
