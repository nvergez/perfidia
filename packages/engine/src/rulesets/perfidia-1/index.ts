// @perfidia/engine/rulesets/perfidia-1: the perfidia-1 ruleset (docs/rulesets/perfidia-1.md).
// Wave 3 (T06): config, world and pure rules. Wave 4 (T11): the mechanics hooks and the
// `perfidia1_1_0_0` descriptor; every wave-3 export is kept unchanged.
//
// Clarification of the ruleset doc, written into its §13.2 and recorded with the deviations of
// docs/architecture.md (§17.1): while the match runs, the leaderboard (`hooks.standings`, in
// `victory.ts`) ranks by score, then cities, then the public tie-break order; battle points, which
// §12 keeps private, break ties only in the final ranking of §13.4, once the match has ended.
// Found by T16: under P10, the order of tied players showed their raw battle points.

export * from "./names.ts";
export * from "./config.ts";
export {
  AtLeastOne,
  BuildingSchema,
  Int,
  KindSchema,
  OccupiedKindSchema,
  Offset,
  Pace,
  QuadSchema,
  RequiresSchema,
  SeedUnitsSchema,
  TableSize,
  Tiles,
  UnitSchema,
  coreSections,
  crossFieldIssuesFor,
  duration,
  fixed,
} from "./schema.ts";
export { compileRulesWith } from "./compiler.ts";
export { createWorldWith } from "./world.ts";
export { scoreRowsBy } from "./score.ts";
export * from "./check.ts";
export * from "./compile.ts";
export * from "./cheatsheet.ts";
export * from "./sin10k.ts";
export * from "./map.ts";
export * from "./travel.ts";
export * from "./combat.ts";
export * from "./spy.ts";
export * from "./scoring.ts";
export * from "./domination.ts";
export * from "./ext.ts";
export * from "./errors.ts";

export * from "./events.ts";
export { PerfidiaError, type PCtx, type PCtx100, type PRead, type PRead100 } from "./common.ts";
export {
  SIEGE_END,
  announceHomecoming,
  breakSiege,
  eliminatePlayer,
  garrisonSettlers,
  onSiegeEnd,
  returnsInto,
  siegeHooksWith,
  startSiege,
  type ScorePartsOf,
  type SiegeHooks,
} from "./siege.ts";
export { arriveAttack, arriveReturn, bounceHome, creditBlocked } from "./battle.ts";
export {
  arriveFound,
  arriveShipment,
  arriveSpy,
  arriveSupport,
  landPopPresent,
} from "./arrivals.ts";
export { departure, guard } from "./departure.ts";
export {
  DOMINATION_END,
  afterStep,
  announceNewReturns,
  cancelCountdown,
  checkGarrisons,
  finish,
  onDominationEnd,
  onDominationOpen,
  relatedPairs,
  standings,
  trackRelations,
} from "./victory.ts";
export { perfidiaVisibility } from "./visibility.ts";
export { perfidiaInvariants, perfidiaInvariantsFor } from "./invariants.ts";
export { perfidia1_1_0_0 } from "./v1_0_0.ts";
