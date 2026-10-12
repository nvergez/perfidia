import type { GameTime, LogLine } from "@perfidia/protocol";

// When a match starts fighting (docs/architecture.md §12.2): the game time of its first battle,
// first conquest and first elimination, and the domination countdowns it opened, folded from its
// `ev` lines by event type. Ruleset-agnostic: `battle`, `city_conquered` and `player_eliminated`
// are standard events; a ruleset without domination countdowns (sandbox-1) just never opens one.

/** The public start of a domination countdown (perfidia-1 §13.3). */
export const DOMINATION_STARTED = "domination_started";

export interface FightTimes {
  /** Game-seconds of the first `battle` event; null when the match had none. */
  readonly firstBattleT: GameTime | null;
  readonly firstConquestT: GameTime | null;
  readonly firstEliminationT: GameTime | null;
  /** Domination countdowns opened (`domination_started` events). */
  readonly dominationCountdowns: number;
  readonly firstDominationT: GameTime | null;
}

const earliest = (a: GameTime | null, t: GameTime): GameTime => (a === null ? t : Math.min(a, t));

/** The fight times of a log (any lines; only `ev` lines count). */
export function fightTimes(lines: Iterable<LogLine>): FightTimes {
  let firstBattleT: GameTime | null = null;
  let firstConquestT: GameTime | null = null;
  let firstEliminationT: GameTime | null = null;
  let firstDominationT: GameTime | null = null;
  let dominationCountdowns = 0;
  for (const line of lines) {
    if (line.k !== "ev") continue;
    const type = line.e.type;
    if (type === "battle") firstBattleT = earliest(firstBattleT, line.t);
    else if (type === "city_conquered") firstConquestT = earliest(firstConquestT, line.t);
    else if (type === "player_eliminated") firstEliminationT = earliest(firstEliminationT, line.t);
    else if (type === DOMINATION_STARTED) {
      dominationCountdowns += 1;
      firstDominationT = earliest(firstDominationT, line.t);
    }
  }
  return {
    firstBattleT,
    firstConquestT,
    firstEliminationT,
    dominationCountdowns,
    firstDominationT,
  };
}

/** A first-event time over the runs of a variant. */
export interface FirstTimeStat {
  /** Runs that had the event. */
  readonly runs: number;
  /** Mean over those runs, in game-seconds rounded to the second; null when none had it. */
  readonly mean: GameTime | null;
  /** The earliest over those runs; null when none had it. */
  readonly min: GameTime | null;
}

/** The mean and earliest of the non-null times. */
export function firstTimeStat(times: readonly (GameTime | null)[]): FirstTimeStat {
  const had = times.filter((t): t is GameTime => t !== null);
  if (had.length === 0) return { runs: 0, mean: null, min: null };
  const sum = had.reduce((a, b) => a + b, 0);
  return { runs: had.length, mean: Math.round(sum / had.length), min: Math.min(...had) };
}
