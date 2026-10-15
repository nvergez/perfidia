import type { DeepReadonly, GameState, PlayerId, Standing } from "@perfidia/protocol";
import { BUILDING_IDS, CROWN_TAG, type PerfidiaConfig } from "./config.ts";
import type { PerfidiaExt } from "./ext.ts";
import { type ScoreRow, scoreRowsBy, standingsOf } from "./score.ts";

// Score, standings and final ranking (perfidia-1 §13.1, §13.2, §13.4). The public score parts are
// the city points and the capped battle score; raw battle points never leave the engine. The parts
// every version shares are `score.ts`'s.

export {
  battleScore,
  rankPlayers,
  standingsOf,
  timeWinner,
  type RankRow,
  type ScoreRow,
} from "./score.ts";

/** Points of one city: `100 + Σ building levels + (100 if it is the Crown)` (§13.1). */
export function cityPoints(
  config: DeepReadonly<PerfidiaConfig>,
  levelSum: number,
  isCrown: boolean,
): number {
  const s = config.scoring;
  return s.cityBase + s.perBuildingLevel * levelSum + (isCrown ? s.crownBonus : 0);
}

/**
 * The score of every player of the state (§13.1), in player order: computed live, except for an
 * eliminated player whose score was frozen at its elimination (§9.7).
 */
export function scoreRows(
  config: DeepReadonly<PerfidiaConfig>,
  state: DeepReadonly<GameState>,
  ext: DeepReadonly<PerfidiaExt>,
): ScoreRow[] {
  return scoreRowsBy(config, state, ext, (city) => {
    let levels = 0;
    for (const b of BUILDING_IDS) levels += city.buildings[b] ?? 0;
    return cityPoints(config, levels, city.tag === CROWN_TAG);
  });
}

/** The standings of a state (§13.2), with the winners first when the match has some. */
export function computeStandings(
  config: DeepReadonly<PerfidiaConfig>,
  state: DeepReadonly<GameState>,
  ext: DeepReadonly<PerfidiaExt>,
  winners: readonly PlayerId[] = [],
): Standing[] {
  return standingsOf(scoreRows(config, state, ext), winners, ext.tiebreak);
}
