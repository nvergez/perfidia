// @perfidia/engine: the top barrel (docs/architecture.md §2.2). Nothing inside the engine imports it.
// It exports the core, the contract types and the kernel's errors, config resolution and replay
// types. The kernel's `createMatch`, `loadMatch` and `verifyLog` take the domain module as an
// argument; the bound versions (domain module and registry filled in) are added here with `std`
// and `domain` (§15, T10). Until then, import the unbound ones from `@perfidia/engine/kernel`.

export * from "./core/index.ts";
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
  RulesetStatus,
  StepInfo,
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
  SnapshotMismatch,
  checkRules,
  configHashOf,
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

// Placeholder still imported by the gateway placeholder; removed once nothing imports it (§15.1).
export const ENGINE_PACKAGE = "@perfidia/engine";
