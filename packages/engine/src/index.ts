// @perfidia/engine: the top barrel (docs/architecture.md §2.2). Nothing inside the engine imports it.
// It exports the core, the contract types, the kernel, `std`, the default domain module and the
// bound `createMatch`, `loadMatch` and `verifyLog`, which fill in the domain module (§5.3). The
// ruleset registry and a `verifyLog(lines, opts)` resolving through it come with the registry
// (§3.5, §15 T14); until then `verifyLog` takes the resolver as an argument.

import type { AnyRuleset } from "./contracts/index.ts";
import { domain } from "./domain/index.ts";
import {
  createMatch as createKernelMatch,
  loadMatch as loadKernelMatch,
  verifyLog as verifyKernelLog,
  type Match,
  type MatchOptions,
  type ReplayReport,
  type VerifyOptions,
} from "./kernel/index.ts";
import type { LogLine, MatchSetup, Snapshot } from "@perfidia/protocol";

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
  type InvariantLevel,
  type Match,
  type MatchOptions,
  type ReplayDivergence,
  type ReplayReport,
  type StepOutput,
  type VerifyOptions,
} from "./kernel/index.ts";
export * from "./std/index.ts";
export * from "./domain/index.ts";

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
 * Level E verification of a log (§10.4) with the default domain module; `resolve` maps the header's
 * ruleset ref to a ruleset (the registry's `findRuleset` once it exists).
 */
export function verifyLog(
  lines: Iterable<LogLine>,
  resolve: (ref: string) => AnyRuleset | undefined,
  opts?: VerifyOptions,
): ReplayReport {
  return verifyKernelLog(lines, resolve, domain, opts);
}

// Placeholder still imported by the gateway placeholder; removed once nothing imports it (§15.1).
export const ENGINE_PACKAGE = "@perfidia/engine";
