// @perfidia/engine/testing: the testing kit (docs/architecture.md §5.3, §15 T04), reused by later
// tasks' tests: the fixture ruleset, a fake domain module, state builders, `matchFromState`,
// `testStep` and a log recorder. Never imported by engine sources outside tests.

export * from "./fixture.ts";
export * from "./domain.ts";
export * from "./state.ts";
export * from "./match.ts";
export * from "./log.ts";
export { addUnits, hasUnits, must, own, sendHome, takeUnits, unitTotal } from "./util.ts";
