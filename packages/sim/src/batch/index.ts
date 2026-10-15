// `sim batch` (docs/architecture.md §12.1, §12.2, §13.9): variants × seeds in lockstep, the batch
// tables, the JSON with provenance, the fight times, the per-seat and per-bot measures, the battle
// split, free slots, domination countdowns, teamwork (joint attacks, sieges, war calls, R1 reach)
// and the pacing measurement.

export { parseVariant, parseVariants, type Variant } from "./variants.ts";
export {
  aggregatePacing,
  dayOf,
  freeSlotCount,
  measureState,
  pacingOf,
  type PacingDay,
  type PacingRow,
} from "./pacing.ts";
export {
  BATCH_FORMAT,
  batchRunDir,
  preflightBatch,
  runBatch,
  writeBatchJson,
  type BatchPlan,
  type BatchResult,
  type CountdownStat,
  type EndCounts,
  type MatchRow,
  type RunMean,
  type VariantAggregate,
  type VariantResult,
} from "./batch.ts";
export {
  HOMECOMING,
  battleRecords,
  battleSplit,
  isRelief,
  type BattleRecord,
  type BattleSplit,
} from "./battles.ts";
export { DOMINATION_CANCELLED, countdownRows, type CountdownRow } from "./countdowns.ts";
export {
  botName,
  seatRows,
  strategyRows,
  wilson,
  type SeatRow,
  type StrategyRow,
} from "./seats.ts";
export {
  freeSlotsAt,
  freeSlotsOf,
  initialFreeSlots,
  initialWorld,
  type FreeSlots,
  type InitialWorld,
} from "./slots.ts";
export {
  DOMINATION_STARTED,
  eliminations,
  fightTimes,
  firstTimeStat,
  type Elimination,
  type FightTimes,
  type FirstTimeStat,
} from "./fights.ts";
export {
  CALL_LEAD,
  JOINT_WINDOW,
  R1_CONQUERED,
  R1_SHARE_PM,
  controllersOf,
  siegeCounts,
  teamBotRows,
  teamRecords,
  teamStat,
  type InitialMap,
  type JointAttack,
  type R1Reach,
  type SiegeCounts,
  type SiegeHold,
  type SiegeOutcome,
  type TeamBotRow,
  type TeamOfMatch,
  type TeamRecords,
  type TeamStat,
  type WarCallStat,
} from "./teams.ts";
export {
  battlesTable,
  countdownTable,
  endsTable,
  fightTable,
  gameClockText,
  matchLandTable,
  matchTable,
  matchTeamTable,
  pacingTable,
  seatTable,
  siegeTable,
  strategyTable,
  teamTable,
  variantTable,
} from "./table.ts";
export { BATCH_USAGE, batchCommand } from "./command.ts";
