import type { AnyRuleset } from "@perfidia/engine";
import { canonicalJson, fmt, sha256Hex } from "@perfidia/engine/core";
import type { Sha256 } from "@perfidia/protocol";

// The ruleset fingerprint (docs/architecture.md §13.6): everything agents see from a ruleset, at
// every allowed N — its defaults, the compiled rules and the cheat sheet for each N, and every
// error and warning explainer rendered on its samples with core's `fmt`. A published version whose
// fingerprint changes was altered (§3.5).

/** What the fingerprint hashes; `compiled` and `cheatSheets` are keyed by N. */
export interface RulesetArtefacts {
  readonly defaults: unknown;
  readonly compiled: Readonly<Record<string, unknown>>;
  readonly cheatSheets: Readonly<Record<string, string>>;
  readonly errors: readonly unknown[];
}

/** The artefacts the fingerprint hashes: `{defaults, compiled, cheatSheets, errors}`. */
export function rulesetArtefacts(rs: AnyRuleset): RulesetArtefacts {
  const { min, max } = rs.players(rs.defaults);
  const compiled: Record<string, unknown> = {};
  const cheatSheets: Record<string, string> = {};
  for (let n = min; n <= max; n += 1) {
    const rules = rs.compile(rs.defaults, n);
    compiled[String(n)] = rules;
    cheatSheets[String(n)] = rs.cheatSheet(rs.defaults, rules);
  }
  const errors = rs.errorSamples.map((v) => {
    const explainer = Object.hasOwn(rs.errors, v.code) ? rs.errors[v.code] : undefined;
    const text =
      explainer === undefined ? null : explainer({ code: v.code, details: { ...v.details } }, fmt);
    return {
      code: v.code,
      details: { ...v.details },
      text: text === null ? null : { message: text.message, hint: text.hint },
    };
  });
  return { defaults: rs.defaults, compiled, cheatSheets, errors };
}

/** `sha256Hex(canonicalJson({defaults, compiled, cheatSheets, errors}))` (§13.6). */
export function rulesetFingerprint(rs: AnyRuleset): Sha256 {
  return sha256Hex(canonicalJson(rulesetArtefacts(rs)));
}
