// @perfidia/engine: the top barrel (docs/architecture.md §2.2). Nothing inside the engine imports it.
// It exports the core, the contract types, the kernel, `std`, the default domain module, the
// ruleset registry (§3.5) and the bound `createMatch`, `loadMatch`, `verifyLog` and `createReplay`,
// which fill in the domain module (§5.3); `verifyLog(lines, opts)` resolves the header's ruleset
// through the registry, and `verifyLog(lines, resolve, opts)` through a resolver of the caller's
// (`createReplay(header, …)` likewise).

import type { AnyRuleset } from "./contracts/index.ts";
import { domain } from "./domain/index.ts";
import {
  createMatch as createKernelMatch,
  createReplay as createKernelReplay,
  loadMatch as loadKernelMatch,
  verifyLog as verifyKernelLog,
  type Match,
  type MatchOptions,
  type Replay,
  type ReplayReport,
  type VerifyOptions,
} from "./kernel/index.ts";
import { findRuleset } from "./rulesets/index.ts";
import type { HeaderLine, LogLine, MatchSetup, Snapshot } from "@perfidia/protocol";

export * from "./core/index.ts";
// Every contract type; `Rng` and `Fmt` come from `core`, which declares the same structural types.
export type {
  ActionHandler,
  AnyRuleset,
  ConfigIssue,
  Ctx,
  DepartureDraft,
  DepartureVerdict,
  DomainModule,
  EventHandler,
  EventHook,
  Explainer,
  ExtraTool,
  Invariant,
  ReadCtx,
  Relation,
  Ruleset,
  RulesetHooks,
  RulesetRef,
  RulesetStatus,
  StepInfo,
  TravelGroup,
  Visibility,
  WorldCtx,
  WorldSetup,
  WorldTimer,
} from "./contracts/index.ts";
export {
  ENGINE_VERSION,
  EngineBug,
  EngineMisuse,
  HOUR,
  MatchConfigError,
  MintedIds,
  SnapshotMismatch,
  checkRules,
  compareScheduled,
  configHashOf,
  eventProblems,
  kernelInvariants,
  parseOverride,
  resolveConfig,
  rulesHashOf,
  stateHash,
  type ApplyOutput,
  type DivergenceKind,
  type EngineBugKind,
  type FinishOptions,
  type InvariantLevel,
  type Match,
  type MatchOptions,
  type Replay,
  type ReplayDivergence,
  type ReplayReport,
  type ReplayStep,
  type StepOutput,
  type VerifyOptions,
} from "./kernel/index.ts";
export * from "./std/index.ts";
export * from "./domain/index.ts";
export {
  RULESETS,
  RegistryError,
  UnknownRuleset,
  findRuleset,
  getRuleset,
  parseRulesetRef,
  validateRegistry,
} from "./rulesets/index.ts";

/**
 * Creates a match of `ruleset` with the default domain module (§5.3 "Creation"). Throws
 * `MatchConfigError` on a setup, config or world that fails the checks of §3.6.
 */
export function createMatch(setup: MatchSetup, ruleset: AnyRuleset, opts?: MatchOptions): Match {
  return createKernelMatch(setup, ruleset, domain, opts);
}

/** Loads a snapshot with the default domain module (§5.3 "Loading"); throws `SnapshotMismatch`. */
export function loadMatch(snap: Snapshot, ruleset: AnyRuleset, opts?: MatchOptions): Match {
  return loadKernelMatch(snap, ruleset, domain, opts);
}

/**
 * Level E verification of a log (§10.4) with the default domain module. The header's ruleset ref is
 * resolved through the registry (`findRuleset`), or through `resolve` when one is given (tests with
 * their own rulesets).
 */
export function verifyLog(lines: Iterable<LogLine>, opts?: VerifyOptions): ReplayReport;
export function verifyLog(
  lines: Iterable<LogLine>,
  resolve: (ref: string) => AnyRuleset | undefined,
  opts?: VerifyOptions,
): ReplayReport;
export function verifyLog(
  lines: Iterable<LogLine>,
  second?: ((ref: string) => AnyRuleset | undefined) | VerifyOptions,
  third?: VerifyOptions,
): ReplayReport {
  if (typeof second === "function") return verifyKernelLog(lines, second, domain, third);
  return verifyKernelLog(lines, (ref) => findRuleset(ref), domain, second);
}

/**
 * The incremental Level E replay of a log (§10.4) with the default domain module: `push` each line
 * after the header, in file order. The ruleset is resolved like `verifyLog`'s.
 */
export function createReplay(header: HeaderLine, opts?: VerifyOptions): Replay;
export function createReplay(
  header: HeaderLine,
  resolve: (ref: string) => AnyRuleset | undefined,
  opts?: VerifyOptions,
): Replay;
export function createReplay(
  header: HeaderLine,
  second?: ((ref: string) => AnyRuleset | undefined) | VerifyOptions,
  third?: VerifyOptions,
): Replay {
  if (typeof second === "function") return createKernelReplay(header, second, domain, third);
  return createKernelReplay(header, (ref) => findRuleset(ref), domain, second);
}
