// @perfidia/engine/rulesets/perfidia-1: the perfidia-1 ruleset (docs/rulesets/perfidia-1.md).
// Wave 3 (T06): config, world and pure rules. Wave 4 (T11): the mechanics hooks and the
// `perfidia1_1_0_0` descriptor; every wave-3 export is kept unchanged.

export * from "./config.ts";
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
export { PerfidiaError, type PCtx, type PRead } from "./common.ts";
export {
  SIEGE_END,
  announceHomecoming,
  breakSiege,
  eliminatePlayer,
  garrisonSettlers,
  onSiegeEnd,
  returnsInto,
  startSiege,
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
  finish,
  onDominationEnd,
  onDominationOpen,
  relatedPairs,
  standings,
} from "./victory.ts";
export { perfidiaVisibility } from "./visibility.ts";
export { perfidiaInvariants } from "./invariants.ts";
export { perfidia1_1_0_0 } from "./v1_0_0.ts";
