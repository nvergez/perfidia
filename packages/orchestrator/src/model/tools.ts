import type { Json, JsonObject } from "@perfidia/protocol";
import type { ModelTool } from "./adapter.ts";

// The tool schemas as Anthropic's `input_schema` takes them (phase-2 design §2.4): the gateway's
// `toolDefinitions` with the root `$schema` dropped and Zod's safe-integer noise
// (`maximum: 9007199254740991`) removed. `strict` stays off for every tool: the gateway's Zod check
// is authoritative and answers bad arguments with `INVALID_ARGS` and a hint. The output is
// deterministic (the gateway's keys are already canonical, `TOOL_NAMES` order is kept) and deeply
// frozen, so the tools bytes of every request of a match are identical (§4.1).

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

/** The transform of every tool, in the given order; computed once per match. */
export function anthropicTools(defs: readonly ToolSource[]): readonly ModelTool[] {
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
