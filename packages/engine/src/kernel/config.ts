import { CanonicalJsonError, canonicalJson, sha256Hex } from "@perfidia/engine/core";
import type { Ruleset } from "@perfidia/engine/contracts";
import {
  CompiledRulesSchema,
  ConfigPathSchema,
  JsonSchema,
  MAX_SEATS,
  compareIds,
  type CompiledRules,
  type ConfigIssue,
  type DeepReadonly,
  type Json,
  type Sha256,
} from "@perfidia/protocol";
import { checkRules } from "./checks.ts";
import { readonlyView } from "./copy.ts";
import { errorMessage } from "./errors.ts";

// Overrides, config resolution and the compile checks (docs/architecture.md §3.6).

/**
 * Parses one CLI override `key.path=value`. The value is parsed as JSON when it parses (`5`, `true`,
 * `[1,2]`, `"x"`), otherwise taken as a string. The path must be a dotted config path.
 */
export function parseOverride(s: string): { path: string; value: Json } | { error: string } {
  const eq = s.indexOf("=");
  if (eq < 0) return { error: `override "${s}" has no "=": write key.path=value` };
  const path = s.slice(0, eq);
  const text = s.slice(eq + 1);
  const pathCheck = ConfigPathSchema.safeParse(path);
  if (!pathCheck.success) {
    return { error: `override "${s}": ${pathCheck.error.issues[0]?.message ?? "invalid path"}` };
  }
  let value: unknown = text;
  try {
    value = JSON.parse(text);
  } catch {
    value = text;
  }
  const valueCheck = JsonSchema.safeParse(value);
  if (!valueCheck.success) {
    return { error: `override "${s}": ${valueCheck.error.issues[0]?.message ?? "invalid value"}` };
  }
  return { path, value: valueCheck.data };
}

/** `sha256Hex(canonicalJson({ruleset: ref, config}))`, the effective config hash (§3.6). */
export function configHashOf(ref: string, config: unknown): Sha256 {
  return sha256Hex(canonicalJson({ ruleset: ref, config }));
}

/** `sha256Hex(canonicalJson(rules))`, the hash of the compiled tables of a match (§3.3). */
export function rulesHashOf(rules: DeepReadonly<CompiledRules>): Sha256 {
  return sha256Hex(canonicalJson(rules));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** A deep copy of a JSON-like value: plain objects and arrays are copied, anything else is kept. */
function cloneJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = cloneJson(v);
    return out;
  }
  return value;
}

const INDEX = /^(0|[1-9][0-9]*)$/;

function describeKeys(keys: readonly string[]): string {
  return keys.length === 0 ? "none" : keys.join(", ");
}

/** Sets `path` in `root`; returns the problem, or null when it was set. */
function setPath(root: unknown, path: string, value: Json): string | null {
  const segments = path.split(".");
  let node = root;
  for (const [i, segment] of segments.entries()) {
    const here = segments.slice(0, i).join(".");
    const where = here === "" ? "the top level" : `"${here}"`;
    const last = i === segments.length - 1;
    if (Array.isArray(node)) {
      if (!INDEX.test(segment) || Number(segment) >= node.length) {
        const range = node.length === 0 ? "none" : `0..${node.length - 1}`;
        return `unknown config path "${path}": "${segment}" is not an index of ${where} (valid indices: ${range})`;
      }
      const index = Number(segment);
      if (last) node[index] = cloneJson(value);
      else node = node[index];
    } else if (isPlainObject(node)) {
      if (!Object.hasOwn(node, segment)) {
        const keys = Object.keys(node).toSorted(compareIds);
        return `unknown config path "${path}": ${where} has no key "${segment}" (valid keys: ${describeKeys(keys)})`;
      }
      if (last) node[segment] = cloneJson(value);
      else node = node[segment];
    } else {
      return `unknown config path "${path}": ${where} is a value, not an object, so it has no key "${segment}"`;
    }
  }
  return null;
}

interface ZodIssueLike {
  readonly code?: string;
  readonly path: readonly PropertyKey[];
  readonly message: string;
  readonly values?: readonly unknown[];
}

function issuePath(path: readonly PropertyKey[]): string {
  return path.map((p) => String(p)).join(".");
}

function configIssue(issue: ZodIssueLike, ref: string): ConfigIssue {
  const path = issuePath(issue.path);
  const fixed = issue.code === "invalid_value" && issue.values?.length === 1;
  const message = fixed
    ? `this field is fixed by ${ref} (it must be ${JSON.stringify(issue.values?.[0])}): ${issue.message}`
    : issue.message;
  return { path, message };
}

/** `$.a.b[2]` (a `CanonicalJsonError` path) as the dotted path `a.b.2`. */
function dottedFromCanonical(path: string): string {
  return path
    .replace(/^\$/, "")
    .replace(/\["((?:[^"\\]|\\.)*)"\]/g, (_m, key: string) => {
      const unescaped: unknown = JSON.parse(`"${key}"`);
      return `.${typeof unescaped === "string" ? unescaped : key}`;
    })
    .replace(/\[(\d+)\]/g, ".$1")
    .replace(/^\./, "");
}

function dedupe(issues: readonly ConfigIssue[]): ConfigIssue[] {
  const seen = new Set<string>();
  const out: ConfigIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.path}\n${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out;
}

/** The successful resolution, with the compiled rules of every allowed N (kernel-internal). */
export interface ResolvedConfig<C> {
  readonly ok: true;
  readonly config: C;
  readonly hash: Sha256;
  readonly players: { readonly min: number; readonly max: number };
  /** `compile(config, N)` for every allowed N, each passing the compile checks. */
  readonly compiled: ReadonlyMap<number, CompiledRules>;
}

/** `resolveConfig` with the compiled rules of every allowed N (used by the kernel to compile once). */
export function resolveConfigFull<C>(
  rs: Ruleset<C>,
  overrides: Readonly<Record<string, Json>>,
): ResolvedConfig<C> | { ok: false; errors: ConfigIssue[] } {
  const draft = cloneJson(rs.defaults);
  const pathErrors: ConfigIssue[] = [];
  for (const path of Object.keys(overrides).toSorted(compareIds)) {
    const value = overrides[path];
    const checked = ConfigPathSchema.safeParse(path);
    if (!checked.success) {
      pathErrors.push({ path, message: checked.error.issues[0]?.message ?? "invalid path" });
      continue;
    }
    if (value === undefined) {
      pathErrors.push({ path, message: "the override has no value" });
      continue;
    }
    const problem = setPath(draft, path, value);
    if (problem !== null) pathErrors.push({ path, message: problem });
  }
  if (pathErrors.length > 0) return { ok: false, errors: pathErrors };

  const parsed = rs.configSchema.safeParse(draft);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => configIssue(i, rs.ref)) };
  }
  const config = parsed.data;

  let hash: Sha256;
  try {
    hash = configHashOf(rs.ref, config);
  } catch (error) {
    if (error instanceof CanonicalJsonError) {
      const path = dottedFromCanonical(error.path).replace(/^config\.?/, "");
      return {
        ok: false,
        errors: [{ path, message: `the config cannot be hashed: ${error.message}` }],
      };
    }
    throw error;
  }

  const frozenView = readonlyView(config);
  let range: { min: number; max: number };
  try {
    range = rs.players(frozenView);
  } catch (error) {
    return {
      ok: false,
      errors: [{ path: "", message: `players(config) threw ${errorMessage(error)}` }],
    };
  }
  const { min, max } = range;
  if (
    !Number.isSafeInteger(min) ||
    !Number.isSafeInteger(max) ||
    min < 1 ||
    min > max ||
    max > MAX_SEATS
  ) {
    return {
      ok: false,
      errors: [
        {
          path: "",
          message: `players(config) is ${min}..${max}; it must be a range of integers within 1..${MAX_SEATS}`,
        },
      ],
    };
  }

  const issues: ConfigIssue[] = [];
  const compiled = new Map<number, CompiledRules>();
  for (let n = min; n <= max; n += 1) {
    let rules: CompiledRules;
    try {
      rules = rs.compile(frozenView, n);
    } catch (error) {
      issues.push({ path: "", message: `compile(config, ${n}) threw ${errorMessage(error)}` });
      continue;
    }
    const shape = CompiledRulesSchema.safeParse(rules);
    if (!shape.success) {
      for (const issue of shape.error.issues) {
        issues.push({
          path: issuePath(issue.path),
          message: `compiled rules (N = ${n}): ${issue.message}`,
        });
      }
      continue;
    }
    if (rules.ruleset !== rs.ref) {
      issues.push({ path: "ruleset", message: `compile returned ${rules.ruleset}, not ${rs.ref}` });
    }
    if (rules.players !== n) {
      issues.push({
        path: "players",
        message: `compile(config, ${n}) returned players = ${rules.players}`,
      });
    }
    issues.push(...checkRules(rules));
    if (rs.check !== undefined) {
      try {
        issues.push(...rs.check(frozenView, rules));
      } catch (error) {
        issues.push({ path: "", message: `check(config) threw ${errorMessage(error)}` });
      }
    }
    compiled.set(n, rules);
  }
  if (issues.length > 0) return { ok: false, errors: dedupe(issues) };
  return { ok: true, config, hash, players: { min, max }, compiled };
}

/**
 * Resolves the effective config of a match (§3.6): deep-clones `defaults`, sets every override path
 * (an unknown path is an error listing the valid sibling keys), validates the whole result with
 * `configSchema` (a fixed field names the ref), hashes it (a canonical-JSON failure is a config
 * error, never thrown), then, for every N in `players(config)`, compiles it and runs the generic
 * `checkRules` and the ruleset's own `check`. Never throws for a bad config.
 */
export function resolveConfig<C>(
  rs: Ruleset<C>,
  overrides: Readonly<Record<string, Json>>,
): { ok: true; config: C; hash: Sha256 } | { ok: false; errors: ConfigIssue[] } {
  const r = resolveConfigFull(rs, overrides);
  return r.ok ? { ok: true, config: r.config, hash: r.hash } : r;
}
