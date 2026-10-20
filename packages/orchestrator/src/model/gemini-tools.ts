import type { Json, JsonObject } from "@perfidia/protocol";
import type { ModelTool } from "./adapter.ts";

// Gemini's tool-schema transform, `gemini@1` (phase-4 design §2.4, §3.2 item 3): the neutral tool
// list rewritten into the JSON Schema subset Gemini documents for `parametersJsonSchema`.
//
// The subset (the API reference's list of supported JSON Schema properties, read 2026-10-20 at
// https://ai.google.dev/api/generate-content.md.txt, and the structured-output guide,
// https://ai.google.dev/gemini-api/docs/structured-output.md.txt) has no `pattern`, `const`,
// `exclusiveMinimum` or `propertyNames`, four of the gateway's fifteen keywords. Each is rewritten
// without changing what the gateway accepts (its Zod check stays authoritative and answers bad
// arguments with INVALID_ARGS):
// - `const: v` (a string or number) becomes `enum: [v]`, the same constraint;
// - `exclusiveMinimum: n` on an integer becomes `minimum: n + 1`, the same constraint; elsewhere it
//   moves into the description ("Must be greater than n.");
// - `pattern: p` moves into the description ("Must match the regular expression p.");
// - `propertyNames: {pattern: p}` moves into the object's description ("Each key must match the
//   regular expression p.").
// Every other keyword is kept, and a keyword outside the subset after the rewrite is a build error
// (a new gateway keyword fails here, not as a 400 at Google). The transform is pure, deterministic
// and idempotent, keeps names, order and descriptions of the tools, and its output's hash is
// recorded per seat (`toolsHash` in `seats.json`).

/** The transform's id, as `arena/providers.ts` names it (bump the version on any change). */
export const GEMINI_TOOL_TRANSFORM_ID = "gemini@1";

/** The JSON Schema keywords Gemini documents for `parametersJsonSchema` (and `propertyOrdering`). */
export const GEMINI_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  "$id",
  "$defs",
  "$ref",
  "$anchor",
  "type",
  "format",
  "title",
  "description",
  "enum",
  "items",
  "prefixItems",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "anyOf",
  "oneOf",
  "properties",
  "additionalProperties",
  "required",
  "propertyOrdering",
]);

const isObject = (v: Json | undefined): v is JsonObject =>
  v !== null && v !== undefined && typeof v === "object" && !Array.isArray(v);

/** One schema node rewritten (sub-schemas included); `at` names it in errors. */
function rewrite(node: Json, at: string): Json {
  if (!isObject(node)) return node;
  const notes: string[] = [];
  const out: JsonObject = {};
  const integer = node["type"] === "integer";
  for (const [k, v] of Object.entries(node)) {
    switch (k) {
      case "pattern":
        if (typeof v !== "string") throw new Error(`${at}: pattern is not a string`);
        notes.push(`Must match the regular expression ${v}.`);
        break;
      case "propertyNames": {
        const p = isObject(v) ? v["pattern"] : undefined;
        if (typeof p === "string") notes.push(`Each key must match the regular expression ${p}.`);
        break;
      }
      case "exclusiveMinimum":
        if (typeof v !== "number") throw new Error(`${at}: exclusiveMinimum is not a number`);
        if (integer && Number.isSafeInteger(v)) {
          const min = node["minimum"];
          out["minimum"] = typeof min === "number" ? Math.max(min, v + 1) : v + 1;
        } else {
          notes.push(`Must be greater than ${v}.`);
        }
        break;
      case "const":
        if ((typeof v === "string" || typeof v === "number") && node["enum"] === undefined) {
          out["enum"] = [v];
        } else {
          notes.push(`Must be ${JSON.stringify(v)}.`);
        }
        break;
      case "minimum":
        // An exclusiveMinimum folded in above wins; else kept as is.
        if (!(k in out)) out[k] = v;
        break;
      case "properties":
        if (!isObject(v)) throw new Error(`${at}: properties is not an object`);
        out[k] = Object.fromEntries(
          Object.entries(v).map(([name, s]) => [name, rewrite(s, `${at}.${name}`)]),
        );
        break;
      case "$defs":
        out[k] = isObject(v)
          ? Object.fromEntries(
              Object.entries(v).map(([n, s]) => [n, rewrite(s, `${at}.$defs.${n}`)]),
            )
          : v;
        break;
      case "items":
      case "additionalProperties":
        out[k] = rewrite(v, `${at}.${k}`);
        break;
      case "anyOf":
      case "oneOf":
      case "prefixItems":
        out[k] = Array.isArray(v) ? v.map((s, i) => rewrite(s, `${at}.${k}[${i}]`)) : v;
        break;
      default:
        out[k] = v;
    }
  }
  if (notes.length > 0) {
    const prior = out["description"];
    const text = notes.join(" ");
    out["description"] = typeof prior === "string" && prior !== "" ? `${prior} ${text}` : text;
  }
  for (const k of Object.keys(out)) {
    if (!GEMINI_SCHEMA_KEYWORDS.has(k)) {
      throw new Error(
        `${at}: the keyword ${k} is outside Gemini's JSON Schema subset; teach ${GEMINI_TOOL_TRANSFORM_ID} to rewrite it (and bump its version)`,
      );
    }
  }
  return out;
}

/** The neutral tools in Gemini's schema subset (names, order and descriptions unchanged). */
export function geminiTools(tools: readonly ModelTool[]): ModelTool[] {
  return tools.map((t) => {
    const schema = rewrite(t.inputSchema, t.name);
    if (!isObject(schema)) throw new Error(`${t.name}: the input schema is not an object`);
    return { name: t.name, description: t.description, inputSchema: schema };
  });
}

/** `gemini@1` as a `ToolTransform` (`model/tools.ts`'s registry). */
export const GEMINI_TOOL_TRANSFORM = Object.freeze({
  id: GEMINI_TOOL_TRANSFORM_ID,
  apply: (tools: readonly ModelTool[]): readonly ModelTool[] => geminiTools(tools),
});
