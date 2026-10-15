import type { CompiledRules, ConfigIssue, DeepReadonly } from "@perfidia/protocol";
import type { PerfidiaCore } from "./config.ts";

// The ruleset-specific compile checks of perfidia-1 §16 (`Ruleset.check`). The generic checks
// (durations, budgets, `urgentMinGap < minTravel`, …) are the kernel's `checkRules`
// (docs/architecture.md §3.6).

/** `siegeDuration > recallWindow` and `sameIslandTravel ≥ minTravel`, each reported at its path. */
export function checkConfig(
  config: DeepReadonly<PerfidiaCore>,
  _rules: DeepReadonly<CompiledRules>,
): ConfigIssue[] {
  const t = config.time;
  const issues: ConfigIssue[] = [];
  if (t.siegeDuration <= t.recallWindow) {
    issues.push({
      path: "time.siegeDuration",
      message:
        `time.siegeDuration (${t.siegeDuration}) must be greater than time.recallWindow (${t.recallWindow}), ` +
        "so no movement can still be recalled when its home city changes hands",
    });
  }
  if (t.sameIslandTravel < t.minTravel) {
    issues.push({
      path: "time.sameIslandTravel",
      message:
        `time.sameIslandTravel (${t.sameIslandTravel}) must be ≥ time.minTravel (${t.minTravel}), ` +
        "so a same-island attack keeps the speed rule",
    });
  }
  return issues;
}
