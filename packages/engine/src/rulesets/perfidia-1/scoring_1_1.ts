import type { ReadCtx } from "@perfidia/engine/contracts";
import type { City, DeepReadonly, GameState, PlayerId, Standing } from "@perfidia/protocol";
import { fail } from "./common.ts";
import { BUILDING_IDS_1_1, OLYMPUS_TAG, type Perfidia11Config } from "./config_1_1.ts";
import type { Perfidia11Ext } from "./ext_1_1.ts";
import { type ScoreRow, scoreRowsBy, standingsOf } from "./score.ts";

// Score of perfidia-1@1.1.0 (docs/rulesets/perfidia-1.md §13.1): 1.0.0's, with the Olympus bonus in
// place of the Crown's. Battle score, frozen scores, standings and ranking are 1.0.0's (`score.ts`).

type Config = DeepReadonly<Perfidia11Config>;
type Ext = DeepReadonly<Perfidia11Ext>;

/** Points of an owned city: `cityBase + perBuildingLevel × Σ levels + olympusBonus (Olympus)`. */
export function cityPoints11(config: Config, city: DeepReadonly<City>): number {
  const s = config.scoring;
  let levels = 0;
  for (const b of BUILDING_IDS_1_1) levels += city.buildings[b] ?? 0;
  const olympus = city.tag === OLYMPUS_TAG ? s.olympusBonus : 0;
  return s.cityBase + s.perBuildingLevel * levels + olympus;
}

/** The score of every player (§13.1), in player order; eliminated players keep their frozen score. */
export function scoreRows11(config: Config, state: DeepReadonly<GameState>, x: Ext): ScoreRow[] {
  return scoreRowsBy(config, state, x, (city) => cityPoints11(config, city));
}

/** The standings of a state (§13.2), with the winners first when the match has some. */
export function computeStandings11(
  config: Config,
  state: DeepReadonly<GameState>,
  x: Ext,
  winners: readonly PlayerId[] = [],
): Standing[] {
  return standingsOf(scoreRows11(config, state, x), winners, x.tiebreak);
}

/** The public score parts of `p` now (§13.1), which an elimination freezes (§9.7). */
export function scoreParts11(
  r: ReadCtx<Perfidia11Config, Perfidia11Ext>,
  p: PlayerId,
): { cityPoints: number; battleScore: number } {
  const row =
    scoreRows11(r.config, r.state, r.ext()).find((x) => x.player === p) ??
    fail(`player ${p} does not exist`);
  return { cityPoints: row.cityPoints, battleScore: row.battleScore };
}
