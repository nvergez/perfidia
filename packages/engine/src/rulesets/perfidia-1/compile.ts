import { compileRulesWith } from "./compiler.ts";
import { NAMES_1_0_0 } from "./names.ts";

// `compile` (docs/architecture.md §3.3): the perfidia-1@1.0.0 config turned into the data tables the
// core reads, through `compiler.ts` with 1.0.0's ids. Pure; every call returns fresh objects.

export { eventClasses, wakeTable } from "./compiler.ts";

/** `Ruleset.compile`: the `CompiledRules` of perfidia-1@1.0.0 for N players. Pure. */
export const compileRules = compileRulesWith(NAMES_1_0_0);
