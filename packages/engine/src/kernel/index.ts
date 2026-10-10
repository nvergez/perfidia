// @perfidia/engine/kernel: match lifecycle, dispatch, hashing, snapshots and replay
// (docs/architecture.md §3.6, §5, §6.4, §6.6, §10.3, §10.4, §13.3). Ruleset-agnostic: it receives the
// ruleset and the domain module as arguments and imports neither `std`, `domain` nor a ruleset.

export { ENGINE_VERSION } from "./version.ts";
export { EngineBug, EngineMisuse, SnapshotMismatch, type EngineBugKind } from "./errors.ts";
export { MatchConfigError, checkRules } from "./checks.ts";
export { configHashOf, parseOverride, resolveConfig, rulesHashOf } from "./config.ts";
export { compareScheduled } from "./queue.ts";
export { eventProblems, kernelInvariants, MintedIds, type InvariantLevel } from "./invariants.ts";
export { HOUR, stateHash } from "./snapshot.ts";
export {
  createMatch,
  loadMatch,
  runTestStep,
  type ApplyOutput,
  type Match,
  type MatchOptions,
  type StepOutput,
} from "./match.ts";
export {
  verifyLog,
  type DivergenceKind,
  type ReplayDivergence,
  type ReplayReport,
  type VerifyOptions,
} from "./replay.ts";
