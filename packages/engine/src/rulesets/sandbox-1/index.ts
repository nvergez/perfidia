// @perfidia/engine/rulesets/sandbox-1: the test-only second ruleset (docs/architecture.md §3.8).
// It proves that two rulesets coexist in one build and that the core does not secretly depend on
// perfidia-1. The registry (T14) lists its descriptor `sandbox1_1_0_0`.

export * from "./config.ts";
export * from "./ext.ts";
export * from "./compile.ts";
export * from "./cheatsheet.ts";
export * from "./map.ts";
export * from "./travel.ts";
export * from "./combat.ts";
export * from "./attack.ts";
export * from "./spy.ts";
export * from "./scoring.ts";
export * from "./hill.ts";
export * from "./visibility.ts";
export * from "./errors.ts";
export * from "./tools.ts";
export * from "./invariants.ts";
export * from "./descriptor.ts";
