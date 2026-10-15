import {
  type City,
  compareIds,
  type DeepReadonly,
  type GameState,
  type GameTime,
  type PlayerId,
  type Standing,
} from "@perfidia/protocol";
import { battlePointsOf, type PerfidiaExt } from "./ext.ts";
import type { PerfidiaCore } from "./schema.ts";

// Score parts, standings and final ranking shared by every perfidia-1 version (§13.1, §13.2,
// §13.4): each version gives its own city points; the battle score, frozen scores, ranking and
// time victory are the same. Raw battle points never leave the engine.

/** `min(floor(battlePoints / 10), floor(cityPoints / 4))` (§13.1). */
export function battleScore(
  config: DeepReadonly<PerfidiaCore>,
  battlePoints: number,
  cityPointsTotal: number,
): number {
  const s = config.scoring;
  return Math.min(
    Math.floor(battlePoints / s.killPopPerPoint),
    Math.floor((cityPointsTotal * s.killCapPm) / 1000),
  );
}

/** Everything the ranking reads about a player. */
export interface RankRow {
  readonly player: PlayerId;
  readonly alive: boolean;
  readonly eliminatedAt: GameTime | null;
  readonly score: number;
  readonly cities: number;
  /** Raw battle points: a ranking tie-break only, never shown. */
  readonly battlePoints: number;
}

/** A player's score and its public parts. */
export interface ScoreRow extends RankRow {
  readonly cityPoints: number;
  readonly battleScore: number;
}

/**
 * `scoreRows` with the points of an owned city given by `pointsOf` (each version's §13.1): the
 * battle score, frozen scores and player order are every version's.
 */
export function scoreRowsBy(
  config: DeepReadonly<PerfidiaCore>,
  state: DeepReadonly<GameState>,
  ext: DeepReadonly<PerfidiaExt>,
  pointsOf: (city: DeepReadonly<City>) => number,
): ScoreRow[] {
  const cities: Record<string, { count: number; points: number }> = {};
  for (const city of Object.values(state.cities)) {
    if (city.owner === null) continue;
    const entry = cities[city.owner] ?? { count: 0, points: 0 };
    entry.count += 1;
    entry.points += pointsOf(city);
    cities[city.owner] = entry;
  }
  return Object.values(state.players)
    .toSorted((a, b) => compareIds(a.id, b.id))
    .map((player) => {
      const own = cities[player.id] ?? { count: 0, points: 0 };
      const bp = battlePointsOf(ext, player.id);
      const frozen =
        !player.alive && Object.hasOwn(ext.frozenScores, player.id)
          ? ext.frozenScores[player.id]
          : undefined;
      const points = frozen?.cityPoints ?? own.points;
      const bs = frozen?.battleScore ?? battleScore(config, bp, own.points);
      return {
        player: player.id,
        alive: player.alive,
        eliminatedAt: player.eliminatedAt,
        score: points + bs,
        cities: own.count,
        battlePoints: bp,
        cityPoints: points,
        battleScore: bs,
      };
    });
}

function tiebreakIndex(tiebreak: readonly PlayerId[], p: PlayerId): number {
  const i = tiebreak.indexOf(p);
  if (i < 0) throw new RangeError(`${p} is not in the tie-break order`);
  return i;
}

/**
 * The final ranking of §13.4, no shared ranks: the winners (or the winning bloc), then every other
 * survivor, both by score, cities, battle points and the public tie-break order; then eliminated
 * players, latest elimination first, then tie-break order.
 */
export function rankPlayers(
  rows: readonly RankRow[],
  winners: readonly PlayerId[],
  tiebreak: readonly PlayerId[],
): PlayerId[] {
  const group = (r: RankRow): number => (winners.includes(r.player) ? 0 : r.alive ? 1 : 2);
  const tb = (r: RankRow): number => tiebreakIndex(tiebreak, r.player);
  return rows
    .toSorted((a, b) => {
      const g = group(a) - group(b);
      if (g !== 0) return g;
      if (group(a) === 2) {
        return (b.eliminatedAt ?? 0) - (a.eliminatedAt ?? 0) || tb(a) - tb(b);
      }
      return (
        b.score - a.score || b.cities - a.cities || b.battlePoints - a.battlePoints || tb(a) - tb(b)
      );
    })
    .map((r) => r.player);
}

/** Public standings in rank order (§13.2): parts `cityPoints` and `battleScore`, never raw battle points. */
export function standingsOf(
  rows: readonly ScoreRow[],
  winners: readonly PlayerId[],
  tiebreak: readonly PlayerId[],
): Standing[] {
  const byPlayer = new Map(rows.map((r) => [r.player, r]));
  return rankPlayers(rows, winners, tiebreak).map((p, i) => {
    const r = byPlayer.get(p);
    if (r === undefined) throw new RangeError(`no score row for ${p}`);
    return {
      player: p,
      rank: i + 1,
      score: r.score,
      parts: { cityPoints: r.cityPoints, battleScore: r.battleScore },
      cities: r.cities,
      alive: r.alive,
    };
  });
}

/** The time victory (§13.3): the first survivor of the ranking without winners, or null. */
export function timeWinner(
  rows: readonly RankRow[],
  tiebreak: readonly PlayerId[],
): PlayerId | null {
  const first = rankPlayers(rows, [], tiebreak)[0];
  const row = rows.find((r) => r.player === first);
  return row?.alive === true ? row.player : null;
}
