// `sim batch` (docs/architecture.md §12.1, §12.2, §13.9): variants × seeds in lockstep, the batch
// tables, the JSON with provenance and the pacing measurement.

export { parseVariant, parseVariants, type Variant } from "./variants.ts";
export {
  aggregatePacing,
  dayOf,
  measureState,
  pacingOf,
  type PacingDay,
  type PacingRow,
} from "./pacing.ts";
export {
  BATCH_FORMAT,
  batchRunDir,
  runBatch,
  writeBatchJson,
  type BatchPlan,
  type BatchResult,
  type MatchRow,
  type VariantAggregate,
  type VariantResult,
} from "./batch.ts";
export { matchTable, pacingTable, variantTable } from "./table.ts";
export { BATCH_USAGE, batchCommand } from "./command.ts";
