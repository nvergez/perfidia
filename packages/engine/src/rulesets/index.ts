// @perfidia/engine/rulesets: the ruleset registry (docs/architecture.md §3.5). Every ruleset version
// this build can run, looked up by exact ref (`perfidia-1@1.0.0`) or by bare id (`perfidia-1`, the
// latest published version, else the latest test version), and checked once by `validateRegistry`.
// A published version is frozen: changing what it does means adding a new descriptor here.

import type { AnyRuleset } from "@perfidia/engine/contracts";
import { domain } from "@perfidia/engine/domain";
import { checkEventKinds, resolveConfig } from "@perfidia/engine/kernel";
import { perfidia1_1_0_0 } from "@perfidia/engine/rulesets/perfidia-1";
import { sandbox1_1_0_0 } from "@perfidia/engine/rulesets/sandbox-1";
import {
  INTEL_EVENT_TYPES,
  RulesetIdSchema,
  RulesetRefSchema,
  STANDARD_EVENT_TYPES,
  SemverSchema,
  TOOL_NAMES,
  z,
} from "@perfidia/protocol";

/** Every ruleset version of this build, published and test. */
export const RULESETS: readonly AnyRuleset[] = Object.freeze([perfidia1_1_0_0, sandbox1_1_0_0]);

/** A ref or id that names no ruleset of the list; `known` lists the refs there are. */
export class UnknownRuleset extends Error {
  readonly ref: string;
  readonly known: readonly string[];

  constructor(ref: string, known: readonly string[]) {
    super(
      `unknown ruleset "${ref}"; this build contains ${known.length === 0 ? "no ruleset" : known.join(", ")}`,
    );
    this.name = "UnknownRuleset";
    this.ref = ref;
    this.known = [...known];
  }
}

/** A registry entry that fails a check of §3.5; `ref` names the ruleset ("" for the list itself). */
export class RegistryError extends Error {
  readonly ref: string;

  constructor(ref: string, message: string) {
    super(ref === "" ? `ruleset registry: ${message}` : `ruleset registry: ${ref}: ${message}`);
    this.name = "RegistryError";
    this.ref = ref;
  }
}

/** `id@MAJOR.MINOR.PATCH` split into its id and version, or null when `s` is not a ruleset ref. */
export function parseRulesetRef(s: string): { id: string; version: string } | null {
  if (!RulesetRefSchema.safeParse(s).success) return null;
  const at = s.indexOf("@");
  return { id: s.slice(0, at), version: s.slice(at + 1) };
}

/** Numeric `MAJOR.MINOR.PATCH` order (versions are validated by `validateRegistry`). */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function latest(list: readonly AnyRuleset[]): AnyRuleset | undefined {
  return list.toSorted((a, b) => compareVersions(b.version, a.version))[0];
}

/**
 * The ruleset an exact ref names, or, for a bare id, its latest published version, else its latest
 * test version (which `sim run` still refuses without `--allow-test`). `undefined` when none.
 */
export function findRuleset(
  refOrId: string,
  list: readonly AnyRuleset[] = RULESETS,
): AnyRuleset | undefined {
  if (parseRulesetRef(refOrId) !== null) return list.find((rs) => rs.ref === refOrId);
  if (!RulesetIdSchema.safeParse(refOrId).success) return undefined;
  const versions = list.filter((rs) => rs.id === refOrId);
  return (
    latest(versions.filter((rs) => rs.status === "published")) ??
    latest(versions.filter((rs) => rs.status === "test"))
  );
}

/**
 * Like `findRuleset`, but validates the list first and throws `UnknownRuleset`, listing the refs
 * of the build, when nothing matches. Validation takes a few milliseconds, so it runs on every
 * call rather than through a module-level memo (no mutable module state in the engine, §6.5).
 */
export function getRuleset(refOrId: string, list: readonly AnyRuleset[] = RULESETS): AnyRuleset {
  validateRegistry(list);
  const rs = findRuleset(refOrId, list);
  if (rs === undefined) {
    throw new UnknownRuleset(
      refOrId,
      list.map((x) => x.ref),
    );
  }
  return rs;
}

/** Whether `schema` converts to a JSON Schema with root `type: "object"` and no root union (§3.7). */
function rootObjectProblem(schema: z.ZodType): string | null {
  let json: Record<string, unknown>;
  try {
    json = z.toJSONSchema(schema);
  } catch (error) {
    return `its args do not convert with z.toJSONSchema (${error instanceof Error ? error.message : String(error)})`;
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (Object.hasOwn(json, key)) return `its args convert to a root ${key}, not a root object`;
  }
  if (json["type"] !== "object") {
    return `its args convert to root type ${JSON.stringify(json["type"] ?? null)}, not "object"`;
  }
  return null;
}

const TOOL_NAME = /^[a-z][a-z0-9_]*$/;

function checkTools(rs: AnyRuleset): void {
  const seen = new Set<string>(TOOL_NAMES);
  for (const tool of rs.tools ?? []) {
    const what = `extra tool ${tool.name}`;
    if (!TOOL_NAME.test(tool.name))
      throw new RegistryError(rs.ref, `${what}: not a snake_case name`);
    if ((TOOL_NAMES as readonly string[]).includes(tool.name)) {
      throw new RegistryError(rs.ref, `${what} collides with the standard tool of that name`);
    }
    if (seen.has(tool.name)) throw new RegistryError(rs.ref, `${what} is declared twice`);
    seen.add(tool.name);
    const problem = rootObjectProblem(tool.args);
    if (problem !== null) throw new RegistryError(rs.ref, `${what}: ${problem}`);
    if (tool.kind === "write" && rs.hooks.actions?.ext === undefined) {
      throw new RegistryError(
        rs.ref,
        `${what} is a write tool, but hooks.actions.ext is missing to handle its actions`,
      );
    }
    if (tool.kind === "read" && typeof tool.read !== "function") {
      throw new RegistryError(rs.ref, `${what} is a read tool without a read function`);
    }
  }
}

function checkEvents(rs: AnyRuleset): void {
  const own = Object.keys(rs.eventSchemas);
  for (const type of own) {
    if ((STANDARD_EVENT_TYPES as readonly string[]).includes(type)) {
      throw new RegistryError(
        rs.ref,
        `eventSchemas redeclares the standard event type ${type}; standard types keep one shape in every ruleset`,
      );
    }
  }
  for (const type of rs.intelEvents ?? []) {
    if (!own.includes(type)) {
      const standard = (INTEL_EVENT_TYPES as readonly string[]).includes(type)
        ? " (standard intel types are listed by protocol, not by rulesets)"
        : "";
      throw new RegistryError(
        rs.ref,
        `intelEvents names ${type}, which is not a key of eventSchemas${standard}`,
      );
    }
  }
}

function checkSamples(rs: AnyRuleset): void {
  for (const code of Object.keys(rs.errors)) {
    if (!rs.errorSamples.some((v) => v.code === code)) {
      throw new RegistryError(
        rs.ref,
        `errors.${code} has no entry in errorSamples (the explain tests and the fingerprint render every code)`,
      );
    }
  }
}

function checkConfig(rs: AnyRuleset): void {
  // `resolveConfig` parses the defaults, checks `players` against 1..MAX_SEATS, and compiles them
  // for every allowed N with the generic `checkRules` and the ruleset's own `check` (§3.6).
  const resolved = resolveConfig(rs, {});
  if (!resolved.ok) {
    const list = resolved.errors.map((i) =>
      i.path === "" ? i.message : `${i.path}: ${i.message}`,
    );
    throw new RegistryError(rs.ref, `its defaults do not resolve: ${list.join("; ")}`);
  }
  const { min, max } = rs.players(resolved.config);
  for (let n = min; n <= max; n += 1) {
    const issues = checkEventKinds(rs, domain, rs.compile(resolved.config, n), []);
    const first = issues[0];
    if (first !== undefined) {
      throw new RegistryError(
        rs.ref,
        `N = ${n}: ${first.path === "" ? "" : `${first.path}: `}${first.message}`,
      );
    }
  }
}

function checkIdentity(rs: AnyRuleset): void {
  if (!RulesetIdSchema.safeParse(rs.id).success) {
    throw new RegistryError(rs.ref, `id "${rs.id}" is not a ruleset id`);
  }
  if (!SemverSchema.safeParse(rs.version).success) {
    throw new RegistryError(rs.ref, `version "${rs.version}" is not MAJOR.MINOR.PATCH`);
  }
  if (rs.ref !== `${rs.id}@${rs.version}`) {
    throw new RegistryError(rs.ref, `ref is not ${rs.id}@${rs.version}`);
  }
}

/**
 * Throws `RegistryError` on the first problem of the list (§3.5): a duplicate ref; an id, version
 * or ref that do not match; defaults that do not resolve for every allowed N (the config schema,
 * `players` within 1..MAX_SEATS, `compile` and the checks of §3.6); an `eventClasses` map missing a
 * domain or ruleset event kind, or where `match_end` shares its class; a ruleset event type that
 * redeclares a standard one; an `intelEvents` entry that is not a key of `eventSchemas`; an extra
 * tool whose name is not snake_case or collides with `TOOL_NAMES` or another extra, whose `args`
 * do not convert with `z.toJSONSchema` to a root `type: "object"`, which is a `write` tool while
 * `hooks.actions.ext` is missing, or a `read` tool without `read`; an `errors` code without a sample.
 */
export function validateRegistry(list: readonly AnyRuleset[] = RULESETS): void {
  const refs = new Set<string>();
  for (const rs of list) {
    if (refs.has(rs.ref)) throw new RegistryError(rs.ref, "is registered twice");
    refs.add(rs.ref);
  }
  for (const rs of list) {
    checkIdentity(rs);
    checkConfig(rs);
    checkEvents(rs);
    checkTools(rs);
    checkSamples(rs);
  }
}
