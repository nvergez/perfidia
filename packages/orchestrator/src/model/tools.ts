import type { Json, JsonObject } from "@perfidia/protocol";
import type { ModelTool } from "./adapter.ts";

// The tool schemas every model gets (phase-2 design §2.4; phase-4 design §3.1): the gateway's
// `toolDefinitions` with the root `$schema` dropped and Zod's safe-integer noise
// (`maximum: 9007199254740991`) removed. `strict` stays off for every tool: the gateway's Zod check
// is authoritative and answers bad arguments with `INVALID_ARGS` and a hint. The output is
// deterministic (the gateway's keys are already canonical, `TOOL_NAMES` order is kept) and deeply
// frozen, so the tools bytes of every request of a match are identical (§4.1). Phase 4: the same
// neutral list goes to every provider; a provider whose schema dialect is narrower (Gemini's
// `parametersJsonSchema`, Pass 2) gets it through a named `ToolTransform`, whose output's hash is
// recorded per seat (`toolsHash` in `seats.json`), so a transformed list shows.

/** Zod's bound for `z.int()`: not a game rule, just noise in the prompt. */
export const SAFE_INT_MAX = Number.MAX_SAFE_INTEGER;

/** Anthropic tool names: `^[a-zA-Z0-9_-]{1,64}$`. */
export const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/** The JSON Schema keywords the gateway's schemas use, all accepted by a non-strict `input_schema`. */
export const SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "propertyNames",
  "items",
  "minItems",
  "maxItems",
  "pattern",
  "enum",
  "const",
  "anyOf",
  "minimum",
  "maximum",
  "exclusiveMinimum",
]);

/** The tool definitions a gateway gives (structurally `ToolDefinition`). */
export interface ToolSource {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
}

function strip(value: Json, root: boolean): Json {
  if (Array.isArray(value)) return value.map((v) => strip(v, false));
  if (value === null || typeof value !== "object") return value;
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(value)) {
    if (root && k === "$schema") continue;
    if (k === "maximum" && v === SAFE_INT_MAX) continue;
    // `properties` maps names to schemas: its keys are field names, never keywords.
    out[k] = k === "properties" ? stripProperties(v) : strip(v, false);
  }
  return out;
}

function stripProperties(value: Json): Json {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(value)) out[k] = strip(v, false);
  return out;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** The neutral tool list, in the given order; computed once per match. */
export function modelTools(defs: readonly ToolSource[]): readonly ModelTool[] {
  const seen = new Set<string>();
  const out = defs.map((d) => {
    if (!TOOL_NAME.test(d.name)) throw new Error(`tool name ${JSON.stringify(d.name)} is invalid`);
    if (seen.has(d.name)) throw new Error(`tool ${d.name} is defined twice`);
    seen.add(d.name);
    const schema = strip(d.inputSchema, true);
    if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
      throw new Error(`tool ${d.name}: the input schema is not an object`);
    }
    if (schema["type"] !== "object") throw new Error(`tool ${d.name}: the root type is not object`);
    return { name: d.name, description: d.description, inputSchema: schema };
  });
  return deepFreeze(out);
}

/** Every keyword used in a schema (property names excluded), for the allowlist test. */
export function schemaKeywords(schema: Json, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(schema)) {
    for (const v of schema) schemaKeywords(v, into);
  } else if (schema !== null && typeof schema === "object") {
    for (const [k, v] of Object.entries(schema)) {
      into.add(k);
      if (k === "properties" && v !== null && typeof v === "object" && !Array.isArray(v)) {
        for (const p of Object.values(v)) schemaKeywords(p, into);
      } else {
        schemaKeywords(v, into);
      }
    }
  }
  return into;
}

/** Phase 2's name of `modelTools` (Anthropic's `input_schema` takes the neutral list as is). */
export const anthropicTools = modelTools;

/**
 * A provider's rewrite of the neutral tool list (phase-4 design §2.4): `id` names it with its
 * version, and `apply` is pure and deterministic. The identity is the default of every provider.
 */
export interface ToolTransform {
  readonly id: string;
  apply(tools: readonly ModelTool[]): readonly ModelTool[];
}

/** No rewrite: the neutral list (Anthropic, OpenAI, OpenRouter, compat). */
export const IDENTITY_TRANSFORM: ToolTransform = Object.freeze({
  id: "none",
  apply: (tools: readonly ModelTool[]) => tools,
});

/**
 * The transforms by the id a provider names (`arena/providers.ts`'s `toolTransform`): only the
 * identity in this build (Gemini's arrives with its adapter, Pass 2).
 */
export const TOOL_TRANSFORMS: Readonly<Record<string, ToolTransform>> = Object.freeze({
  none: IDENTITY_TRANSFORM,
});

/** The transform named `id`; an unknown name is a build error. */
export function toolTransformOf(id: string): ToolTransform {
  const t = Object.hasOwn(TOOL_TRANSFORMS, id) ? TOOL_TRANSFORMS[id] : undefined;
  if (t === undefined) throw new Error(`no tool transform named ${JSON.stringify(id)}`);
  return t;
}

/** `tools` through `t`, deeply frozen (the identity returns the same list). */
export function transformTools(
  tools: readonly ModelTool[],
  t: ToolTransform,
): readonly ModelTool[] {
  if (t === IDENTITY_TRANSFORM) return tools;
  const out = t.apply(tools);
  const names = out.map((x) => x.name).join(",");
  if (names !== tools.map((x) => x.name).join(",")) {
    throw new Error(`tool transform ${t.id} changed the tools' names or order`);
  }
  return deepFreeze([...out]);
}
