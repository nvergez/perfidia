import type { CompiledRules, ConfigIssue, DeepReadonly } from "@perfidia/protocol";
import { checkConfig } from "./check.ts";
import type { Perfidia11Config } from "./config_1_1.ts";
import { type DominationNeed, dominationNeed11, mapSlots } from "./domination_1_1.ts";
import { playerRange } from "./schema.ts";

// The compile checks of perfidia-1@1.1.0 (`Ruleset.check`, §16): 1.0.0's, and the cross-checks of
// the domination keys (R5). The kernel runs `check` once per N; a domination problem is reported
// once, at the first N it fails for, naming every failing N. None applies while domination is off
// (`time.dominationStart` after `time.matchEnd`).

const DISABLE = "or set time.dominationStart after time.matchEnd to disable domination";

/** "6", "6..12", "6, 8..12". */
export function playerCounts(ns: readonly number[]): string {
  const parts: string[] = [];
  let i = 0;
  while (i < ns.length) {
    let j = i;
    while (j + 1 < ns.length && ns[j + 1] === (ns[j] ?? 0) + 1) j += 1;
    parts.push(i === j ? `${ns[i]}` : `${ns[i]}..${ns[j]}`);
    i = j + 1;
  }
  return parts.join(", ");
}

/** The domination cross-checks for N = `players`, reported once over every N of the config. */
export function dominationChecks(
  config: DeepReadonly<Perfidia11Config>,
  players: number,
): ConfigIssue[] {
  const t = config.time;
  if (t.dominationStart > t.matchEnd) return [];
  const { min, max } = playerRange(config);
  const all = Array.from({ length: max - min + 1 }, (_, i) => min + i);
  const v = config.victory;
  const needOf = (n: number): DominationNeed => dominationNeed11(v, n, mapSlots(config, n));
  const issues: ConfigIssue[] = [];
  /** Adds an issue for the N that fail `bad`, at the first of them only. */
  const once = (bad: (n: number) => boolean, issue: (failing: number[]) => ConfigIssue): void => {
    const failing = all.filter(bad);
    if (failing[0] === players) issues.push(issue(failing));
  };

  once(
    (n) => needOf(n).cities < 1,
    (failing) => ({
      path: "victory.dominationPm",
      message: `N = ${playerCounts(failing)}: the domination threshold is 0 cities, so every bloc would qualify at once`,
    }),
  );
  once(
    (n) => needOf(n).cities > mapSlots(config, n),
    (failing) => {
      const n = failing[0] ?? players;
      return {
        path: "victory.dominationMinPerPlayer",
        message:
          `N = ${playerCounts(failing)}: the domination threshold (${needOf(n).cities} cities at N = ${n}: ` +
          `victory.dominationMinPerPlayer ${v.dominationMinPerPlayer} × ${n} players) is more than the map's ` +
          `city slots (${mapSlots(config, n)} at N = ${n}): no bloc could ever dominate. Lower ` +
          `victory.dominationMinPerPlayer, raise map.kinds.*.slots, ${DISABLE}.`,
      };
    },
  );
  once(
    (n) => v.dominationMinConquests > needOf(n).cities,
    (failing) => {
      const n = failing[0] ?? players;
      const lowest = Math.min(...all.map((m) => needOf(m).cities));
      return {
        path: "victory.dominationMinConquests",
        message:
          `N = ${playerCounts(failing)}: victory.dominationMinConquests (${v.dominationMinConquests}) is above ` +
          `the domination threshold (${needOf(n).cities} cities at N = ${n}): lower it to ${lowest} or less.`,
      };
    },
  );
  return issues;
}

/** `Ruleset.check` of 1.1.0: 1.0.0's compile checks, then the domination cross-checks. */
export function checkConfig11(
  config: DeepReadonly<Perfidia11Config>,
  rules: DeepReadonly<CompiledRules>,
): ConfigIssue[] {
  return [...checkConfig(config, rules), ...dominationChecks(config, rules.players)];
}
