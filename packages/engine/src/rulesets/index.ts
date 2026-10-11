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
  DOMAIN_ERROR_CODES,
  GATEWAY_WARNING_CODES,
  INTEL_EVENT_TYPES,
  RulesetIdSchema,
  RulesetRefSchema,
  STANDARD_EVENT_DATA,
  STANDARD_EVENT_TYPES,
  SemverSchema,
  TOOL_NAMES,
  z,
  type CompiledRules,
  type ZodType,
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

/** The data schema of an event type: a standard type's, else the ruleset's own, else `undefined`. */
function eventSchemaOf(rs: AnyRuleset, type: string): ZodType | undefined {
  const standard: Readonly<Record<string, ZodType>> = STANDARD_EVENT_DATA;
  if (Object.hasOwn(standard, type)) return standard[type];
  return Object.hasOwn(rs.eventSchemas, type) ? rs.eventSchemas[type] : undefined;
}

/** Whether an event schema declares a required `key` field (what `publicOncePerDay` groups by). */
function hasKeyField(schema: ZodType): boolean {
  try {
    const json = z.toJSONSchema(schema);
    const props = json["properties"];
    const required = json["required"];
    return (
      props !== null &&
      typeof props === "object" &&
      Object.hasOwn(props, "key") &&
      Array.isArray(required) &&
      required.includes("key")
    );
  } catch {
    return false;
  }
}

/**
 * The gateway tables of one compiled rule set name only event types this build can emit (a
 * misspelt wake key would silently never wake anyone), and every `publicOncePerDay` type carries
 * the `key` field its once-per-day grouping reads.
 */
function checkGatewayTables(rs: AnyRuleset, n: number, rules: CompiledRules): void {
  const unknown = (field: string, type: string): RegistryError =>
    new RegistryError(
      rs.ref,
      `N = ${n}: gateway.${field} names ${type}, which is neither a standard event type nor a key of eventSchemas`,
    );
  for (const type of Object.keys(rules.gateway.wake)) {
    if (eventSchemaOf(rs, type) === undefined) throw unknown("wake", type);
  }
  for (const type of rules.gateway.publicOncePerDay) {
    const schema = eventSchemaOf(rs, type);
    if (schema === undefined) throw unknown("publicOncePerDay", type);
    if (!hasKeyField(schema)) {
      throw new RegistryError(
        rs.ref,
        `N = ${n}: gateway.publicOncePerDay names ${type}, whose data has no required key field to group by`,
      );
    }
  }
}

/**
 * A ruleset code must not reuse a domain code or a gateway warning: the gateway words those
 * itself first, so the ruleset's explainer would be dead text, and a later gateway code of the
 * same name would silently change what agents read under a frozen ref.
 */
function checkErrorCodes(rs: AnyRuleset): void {
  const core = new Set<string>([...DOMAIN_ERROR_CODES, ...GATEWAY_WARNING_CODES]);
  for (const code of Object.keys(rs.errors)) {
    if (core.has(code)) {
      throw new RegistryError(
        rs.ref,
        `errors.${code} reuses a domain or gateway code, which the gateway words itself`,
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
    const rules = rs.compile(resolved.config, n);
    checkGatewayTables(rs, n, rules);
    const issues = checkEventKinds(rs, domain, rules, []);
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
 * `hooks.actions.ext` is missing, or a `read` tool without `read`; an `errors` code without a
 * sample, or one that reuses a domain code or a gateway warning; a `gateway.wake` key or a
 * `publicOncePerDay` entry that is no event type of the build, or a `publicOncePerDay` type
 * without a required `key` field.
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
    checkErrorCodes(rs);
    checkSamples(rs);
  }
}
