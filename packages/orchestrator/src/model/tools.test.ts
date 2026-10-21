import { describe, expect, test } from "bun:test";
import { getRuleset, sha256Hex } from "@perfidia/engine";
import { toolDefinitions } from "@perfidia/gateway/runtime";
import { TOOL_NAMES } from "@perfidia/protocol";
import { SAFE_INT_MAX, SCHEMA_KEYWORDS, anthropicTools, schemaKeywords } from "./tools.ts";

// The Anthropic tool transform (phase-2 design §2.4) on the real gateway definitions.

/**
 * sha256 of the transformed tools of a pinned ruleset version: an agent-visible text. PROMPT_VERSION
 * 3 changed six gateway descriptions (version 2's: 3050f846… and 499cd277…).
 */
const SNAPSHOTS: Readonly<Record<string, string>> = {
  "perfidia-1@1.1.0": "626fa033b5fbc99fc8009da9da9b300e747af1e8bb5be623640b896c9c6e937e",
  "sandbox-1@1.0.0": "07ebd77eba3372693c1638f9340c365ae844fe0c250c783cdf5bb6a274c88111",
};

describe("anthropicTools", () => {
  for (const [ref, count] of [
    ["perfidia-1@1.1.0", 22],
    ["sandbox-1@1.0.0", 24],
  ] as const) {
    test(`${ref}: ${count} tools, root objects, no $schema, no safe-integer noise, allowlisted keywords`, () => {
      const defs = toolDefinitions(getRuleset(ref));
      const tools = anthropicTools(defs);
      expect(tools).toHaveLength(count);
      expect(tools.slice(0, 22).map((t) => t.name)).toEqual([...TOOL_NAMES]);
      const text = JSON.stringify(tools);
      expect(text).not.toContain("$schema");
      expect(text).not.toContain(String(SAFE_INT_MAX));
      // The noise is gone, the descriptions and real bounds are untouched.
      expect(JSON.stringify(defs)).toContain(String(SAFE_INT_MAX));
      for (const [i, t] of tools.entries()) {
        expect(t.inputSchema["type"]).toBe("object");
        expect(t.description).toBe(defs[i]?.description ?? "");
        for (const k of schemaKeywords(t.inputSchema))
          expect([t.name, k, SCHEMA_KEYWORDS.has(k)]).toEqual([t.name, k, true]);
      }
      const maxima = (text.match(/"maximum":/g) ?? []).length;
      expect(maxima).toBe(1);
      // Deterministic and frozen: the same bytes every time, and nothing can change them.
      expect(JSON.stringify(anthropicTools(toolDefinitions(getRuleset(ref))))).toBe(text);
      expect(Object.isFrozen(tools)).toBe(true);
      expect(Object.isFrozen(tools[0]?.inputSchema)).toBe(true);
      expect(sha256Hex(text)).toBe(SNAPSHOTS[ref] ?? "");
    });
  }

  test("refuses invalid names, duplicates and non-object roots", () => {
    const ok = { name: "a", description: "", inputSchema: { type: "object" } };
    expect(() => anthropicTools([{ ...ok, name: "bad name" }])).toThrow("is invalid");
    expect(() => anthropicTools([ok, ok])).toThrow("defined twice");
    expect(() => anthropicTools([{ ...ok, inputSchema: { type: "string" } }])).toThrow(
      "root type is not object",
    );
  });

  test("a property named like a keyword is a field, not stripped", () => {
    const [t] = anthropicTools([
      {
        name: "x",
        description: "d",
        inputSchema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: { maximum: { type: "integer", maximum: SAFE_INT_MAX } },
        },
      },
    ]);
    expect(t?.inputSchema).toEqual({
      type: "object",
      properties: { maximum: { type: "integer" } },
    });
  });
});
