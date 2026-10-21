import { describe, expect, test } from "bun:test";
import { getRuleset } from "@perfidia/engine";
import { canonicalJson, sha256Hex } from "@perfidia/engine/core";
import { toolDefinitions } from "@perfidia/gateway/runtime";
import type { Json } from "@perfidia/protocol";
import { toolsFor } from "../arena/providers.ts";
import {
  GEMINI_SCHEMA_KEYWORDS,
  GEMINI_TOOL_TRANSFORM,
  GEMINI_TOOL_TRANSFORM_ID,
  geminiTools,
} from "./gemini-tools.ts";
import { modelTools, schemaKeywords, toolTransformOf, transformTools } from "./tools.ts";

// Gemini's tool-schema transform (`gemini@1`, phase-4 design §2.4): the neutral list in the JSON
// Schema subset Gemini documents, every rewrite meaning-preserving, the result pinned by hash.

/** The tools of a pinned ruleset version, neutral and transformed. */
function toolsOf(ref: string) {
  const neutral = modelTools(toolDefinitions(getRuleset(ref)));
  return { neutral, gemini: geminiTools(neutral) };
}

const hash = (v: unknown): string => sha256Hex(canonicalJson(v));

/** The schema of one tool's property path (`properties` keys), for spot checks. */
function at(tools: ReturnType<typeof geminiTools>, name: string, ...path: string[]): Json {
  const t = tools.find((x) => x.name === name);
  if (t === undefined) throw new Error(`no tool ${name}`);
  let node: Json = t.inputSchema;
  for (const k of path) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) {
      throw new Error(`${name}: ${k} is not under an object`);
    }
    node = node[k] ?? null;
  }
  return node;
}

describe("gemini@1: the neutral tools in Gemini's schema subset", () => {
  test("only documented keywords remain; names, order and descriptions are kept", () => {
    for (const ref of ["perfidia-1@1.1.0", "perfidia-1@1.0.0", "perfidia-1"]) {
      const { neutral, gemini } = toolsOf(ref);
      const used = new Set<string>();
      for (const t of gemini) schemaKeywords(t.inputSchema, used);
      expect([...used].filter((k) => !GEMINI_SCHEMA_KEYWORDS.has(k))).toEqual([]);
      // The four keywords the subset lacks were all in the neutral list, and are gone.
      const before = new Set<string>();
      for (const t of neutral) schemaKeywords(t.inputSchema, before);
      for (const k of ["pattern", "const", "exclusiveMinimum", "propertyNames"]) {
        expect([ref, k, before.has(k), used.has(k)]).toEqual([ref, k, true, false]);
      }
      expect(gemini.map((t) => [t.name, t.description])).toEqual(
        neutral.map((t) => [t.name, t.description]),
      );
    }
  });

  test("each rewrite keeps the constraint: enum for const, minimum for an integer's exclusiveMinimum, descriptions for patterns", () => {
    const { gemini } = toolsOf("perfidia-1@1.1.0");
    expect(at(gemini, "view_city", "properties", "city")).toEqual({
      type: "string",
      description: "Must match the regular expression ^c[1-9][0-9]*$.",
    });
    expect(at(gemini, "recruit", "properties", "orders", "items", "properties", "count")).toEqual({
      anyOf: [
        { minimum: 1, type: "integer" },
        { enum: ["max"], type: "string" },
      ],
    });
    const units = at(gemini, "attack", "properties", "units");
    expect(units).toMatchObject({
      type: "object",
      additionalProperties: { minimum: 1, type: "integer" },
    });
    expect(JSON.stringify(units)).toContain(
      "Each key must match the regular expression ^[a-z][a-z_]*$.",
    );
    expect(at(gemini, "send_message", "properties", "to")).toMatchObject({
      anyOf: [
        {
          items: {
            type: "string",
            description: "Must match the regular expression ^p[1-9][0-9]*$.",
          },
          minItems: 1,
          type: "array",
        },
        { enum: ["all"], type: "string" },
      ],
    });
    // A property's own description keeps its text, the constraint appended.
    const end = at(gemini, "cancel_queue", "properties", "item");
    expect(end).toMatchObject({ type: "integer", minimum: 1 });
  });

  test("pure, idempotent and frozen through the registry; the hash is pinned", () => {
    const { neutral, gemini } = toolsOf("perfidia-1@1.1.0");
    expect(geminiTools(gemini)).toEqual(gemini);
    expect(geminiTools(neutral)).toEqual(gemini);
    expect(toolTransformOf(GEMINI_TOOL_TRANSFORM_ID)).toBe(GEMINI_TOOL_TRANSFORM);
    const viaRegistry = transformTools(neutral, toolTransformOf("gemini@1"));
    expect(Object.isFrozen(viaRegistry[0]?.inputSchema)).toBe(true);
    expect(viaRegistry).toEqual(gemini);
    // A Google seat's tools (what `seats.json` hashes as `toolsHash`): the transform's output.
    expect(toolsFor("google", neutral)).toEqual(gemini);
    expect(toolsFor("anthropic", neutral)).toBe(neutral);
    expect(hash(neutral)).not.toBe(hash(gemini));
    // Pinned: a change to the transform or to the gateway's schemas shows here (bump gemini@N);
    // the gateway's descriptions too (PROMPT_VERSION 3 changed six: version 2's hash 39f09934…).
    expect(hash(gemini)).toBe("68c795e271e0b89870f848601621a460592a662b206844676fe37ffed1640a95");
    // 1.0.0 and 1.1.0 give the gateway the same tool schemas.
    expect(hash(toolsOf("perfidia-1@1.0.0").gemini)).toBe(
      "68c795e271e0b89870f848601621a460592a662b206844676fe37ffed1640a95",
    );
  });

  test("a keyword outside the subset is a build error, not a 400 at Google", () => {
    const tool = {
      name: "t",
      description: "d",
      inputSchema: { type: "object", properties: { x: { type: "string", minLength: 2 } } },
    } as const;
    expect(() => geminiTools([tool])).toThrow(
      "t.x: the keyword minLength is outside Gemini's JSON Schema subset",
    );
    // A non-integer exclusive bound and a non-scalar const move into the description.
    const odd = geminiTools([
      {
        name: "u",
        description: "d",
        inputSchema: {
          type: "object",
          properties: {
            r: { type: "number", exclusiveMinimum: 0.5, description: "Ratio." },
            k: { const: true },
          },
        },
      },
    ]);
    expect(odd[0]?.inputSchema).toEqual({
      type: "object",
      properties: {
        r: { type: "number", description: "Ratio. Must be greater than 0.5." },
        k: { description: "Must be true." },
      },
    });
  });
});
