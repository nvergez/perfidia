// @perfidia/spectator/stats: per seat per match statistics (phase-4 design §6.1), a pure fold of a
// run directory: `match.jsonl` through the spectator fold, `llm_calls.jsonl` and `seats.json` as
// parsed lines. The cross-match aggregation, the ratings and the `stats` command line live in the
// server package (`packages/server/src/stats/`).

export {
  botIdOf,
  idPart,
  itemOf,
  modelIdOf,
  modelKey,
  parseLabel,
  profileIdOf,
  type LabelModel,
  type SeatKeyParts,
} from "./keys.ts";
export {
  SELF_ID,
  matchStats,
  percentiles,
  type CostByKind,
  type FoldedMatch,
  type MatchStatsOptions,
  type StatsSide,
} from "./match.ts";
export { foldedOf, statsOfLog, type FoldOutcome } from "./log.ts";
