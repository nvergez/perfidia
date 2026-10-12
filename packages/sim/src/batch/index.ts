// `sim batch` (docs/architecture.md §12.1, §12.2, §13.9): variants × seeds in lockstep, the batch
// tables, the JSON with provenance, the fight times, the per-seat and per-bot measures, the battle
// split, free slots, domination countdowns and the pacing measurement.

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
export { freeSlotsAt, freeSlotsOf, initialFreeSlots, type FreeSlots } from "./slots.ts";
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
  battlesTable,
  countdownTable,
  endsTable,
  fightTable,
  gameClockText,
  matchLandTable,
  matchTable,
  pacingTable,
  seatTable,
  strategyTable,
  variantTable,
} from "./table.ts";
export { BATCH_USAGE, batchCommand } from "./command.ts";
