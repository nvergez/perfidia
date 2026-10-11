// `sim verify` (docs/architecture.md §10.4, §12.1): Level E, `--from`, `--dump` and `--resim`.

export { MISSING, jsonDiff, type DiffEntry, type JsonDiff } from "./diff.ts";
export {
  describeDivergence,
  divergentCheckpoint,
  firstDifferentLine,
  verifyRun,
  type VerifyRequest,
} from "./verify.ts";
export { VERIFY_USAGE, verifyCommand } from "./command.ts";
