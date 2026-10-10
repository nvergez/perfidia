import type { ReadCtx } from "@perfidia/engine/contracts";
import { sortedIds } from "@perfidia/engine/std";
import {
  compareIds,
  type DeepReadonly,
  type GameState,
  type GameTime,
  type MatchResult,
  type PlayerId,
  type Standing,
} from "@perfidia/protocol";
import { SANDBOX_BUILDINGS, type SandboxConfig } from "./config.ts";
import type { SandboxExt } from "./ext.ts";

// Score and ranking (docs/architecture.md §3.8): `perCity` (50) per city plus `perLevel` (2) per
// building level, with the public parts `cityPoints` and `levelPoints`. Players rank by score, then
// cities, then player number; no shared ranks. A match won on the hill or by the last player
// standing lists its winner first.

type State = DeepReadonly<GameState>;

/** A player's public score. */
export interface ScoreRow {
  readonly player: PlayerId;
  readonly cities: number;
  readonly cityPoints: number;
  readonly levelPoints: number;
  readonly score: number;
  readonly alive: boolean;
}

/** Every player's score, in player order. */
export function scoreRows(config: DeepReadonly<SandboxConfig>, state: State): ScoreRow[] {
  const cities = sortedIds(state.cities).flatMap((id) => state.cities[id] ?? []);
  return sortedIds(state.players).flatMap((id) => {
    const p = state.players[id];
    if (p === undefined) return [];
    let count = 0;
    let levels = 0;
    for (const c of cities) {
      if (c.owner !== p.id) continue;
      count += 1;
      for (const b of SANDBOX_BUILDINGS) levels += c.buildings[b] ?? 0;
    }
    const cityPoints = config.score.perCity * count;
    const levelPoints = config.score.perLevel * levels;
    return [
      {
        player: p.id,
        cities: count,
        cityPoints,
        levelPoints,
        score: cityPoints + levelPoints,
        alive: p.alive,
      },
    ];
  });
}

/** Score, then cities (both descending), then player number. */
export function compareRows(a: ScoreRow, b: ScoreRow): number {
  return b.score - a.score || b.cities - a.cities || compareIds(a.player, b.player);
}

/** Standings from rows already in rank order. */
export function toStandings(ranked: readonly ScoreRow[]): Standing[] {
  return ranked.map((row, i) => ({
    player: row.player,
    rank: i + 1,
    score: row.score,
    parts: { cityPoints: row.cityPoints, levelPoints: row.levelPoints },
    cities: row.cities,
    alive: row.alive,
  }));
}

/** The leaderboard: every player ranked by score, cities, then player number. */
export function computeStandings(config: DeepReadonly<SandboxConfig>, state: State): Standing[] {
  return toStandings(scoreRows(config, state).toSorted(compareRows));
}

/** The result of a match won by `winner` (hill, last standing), who is ranked first. */
export function winnerResult(
  config: DeepReadonly<SandboxConfig>,
  state: State,
  now: GameTime,
  reason: string,
  winner: PlayerId,
): MatchResult {
  const ranked = scoreRows(config, state).toSorted(compareRows);
  const first = ranked.filter((row) => row.player === winner);
  const rest = ranked.filter((row) => row.player !== winner);
  return { endedAt: now, reason, winners: [winner], standings: toStandings([...first, ...rest]) };
}

/** `hooks.standings`. */
export function standingsHook(r: ReadCtx<SandboxConfig, SandboxExt>): Standing[] {
  return computeStandings(r.config, r.state);
}

/** The result at `matchEnd`: the highest score wins (ties: cities, then player number). */
export function timeResult(
  config: DeepReadonly<SandboxConfig>,
  state: State,
  now: GameTime,
): MatchResult {
  const standings = computeStandings(config, state);
  const top = standings[0];
  return {
    endedAt: now,
    reason: "time",
    winners: top === undefined ? [] : [top.player],
    standings,
  };
}
