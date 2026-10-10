import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { toolArgs } from "./fixtures.test.ts";
import {
  EndTurnArgsSchema,
  RecallTroopsArgsSchema,
  TOOL_ARGS,
  TOOL_INFO,
  TOOL_NAMES,
  TOOL_RESULT_DATA,
  ToolResultSchema,
  z,
  type ToolArgs,
  type ZodType,
} from "./index.ts";

/** The tool table of docs/brief.md ("Agent interface"), family by family. */
const BRIEF_TOOLS = [
  ["view_city", "view_island", "view_map", "view_player", "leaderboard", "rules"],
  ["build", "recruit", "cancel_queue", "send_resources"],
  ["attack", "support", "spy", "recall_troops", "found_city"],
  ["send_message", "propose_alliance", "answer_proposal", "leave_alliance"],
  ["write_note", "read_notes"],
  ["end_turn"],
].flat();

test("TOOL_NAMES is exactly the brief's 22 tools", () => {
  expect(TOOL_NAMES).toHaveLength(22);
  const names: string[] = [...TOOL_NAMES];
  expect(names).toEqual(BRIEF_TOOLS);
  expect(Object.keys(TOOL_ARGS)).toEqual(BRIEF_TOOLS);
  expect(Object.keys(TOOL_INFO)).toEqual(BRIEF_TOOLS);
  expect(Object.keys(TOOL_RESULT_DATA)).toEqual(BRIEF_TOOLS);
});

describe("every tool argument schema is one root object (§3.7)", () => {
  for (const tool of TOOL_NAMES) {
    test(tool, () => {
      const json = z.toJSONSchema(TOOL_ARGS[tool]) as Record<string, unknown>;
      expect(json["type"]).toBe("object");
      expect(json["additionalProperties"]).toBe(false);
      for (const combinator of ["anyOf", "oneOf", "allOf", "not", "if"]) {
        expect(json).not.toHaveProperty(combinator);
      }
      for (const args of toolArgs[tool]) expect(TOOL_ARGS[tool].safeParse(args).success).toBe(true);
    });
  }
});

function issues(args: unknown): { path: PropertyKey[]; message: string }[] {
  const parsed = RecallTroopsArgsSchema.safeParse(args);
  return parsed.success
    ? []
    : parsed.error.issues.map((i) => ({ path: i.path, message: i.message }));
}

describe("recall_troops takes exactly one mode (§7.4)", () => {
  test("accepts each mode alone", () => {
    for (const args of toolArgs.recall_troops) expect(issues(args)).toEqual([]);
  });

  test("rejects no mode", () => {
    expect(issues({})).toEqual([
      { path: [], message: "name exactly one mode: movement, stationedAt or dismiss" },
    ]);
  });

  test("rejects two modes", () => {
    expect(issues({ movement: "m0k4qz", stationedAt: "c9" })).toEqual([
      { path: [], message: "name exactly one mode, not movement and stationedAt" },
    ]);
    expect(issues({ stationedAt: "c9", dismiss: { city: "c3", player: "p4" } })).toHaveLength(1);
    expect(
      issues({ movement: "m0k4qz", stationedAt: "c9", dismiss: { city: "c3", player: "p4" } }),
    ).toHaveLength(1);
  });

  test("rejects home or units without stationedAt", () => {
    expect(issues({ movement: "m0k4qz", home: "c3" })).toEqual([
      { path: ["home"], message: "home applies to stationed units only: add stationedAt" },
    ]);
    expect(issues({ dismiss: { city: "c3", player: "p4" }, units: { guard: 1 } })).toEqual([
      { path: ["units"], message: "units applies to stationed units only: add stationedAt" },
    ]);
    expect(issues({ home: "c3" }).map((i) => i.path)).toEqual([[], ["home"]]);
  });

  test("exactly one mode is accepted (property)", () => {
    const mode = fc.constantFrom("movement", "stationedAt", "dismiss");
    const values = {
      movement: "m0k4qz",
      stationedAt: "c9",
      dismiss: { city: "c3", player: "p4" },
    } as const;
    fc.assert(
      fc.property(fc.uniqueArray(mode, { maxLength: 3 }), fc.boolean(), (modes, withHome) => {
        const args: Record<string, unknown> = Object.fromEntries(modes.map((m) => [m, values[m]]));
        if (withHome) args["home"] = "c3";
        const ok = modes.length === 1 && (!withHome || modes[0] === "stationedAt");
        expect(RecallTroopsArgsSchema.safeParse(args).success).toBe(ok);
      }),
    );
  });
});

describe("end_turn takes at most one wake field (§8.3)", () => {
  test("accepts {} and each field alone", () => {
    expect(EndTurnArgsSchema.safeParse({}).success).toBe(true);
    expect(EndTurnArgsSchema.safeParse({ nextWakeIn: 600 }).success).toBe(true);
    expect(EndTurnArgsSchema.safeParse({ wakeAt: 230520 }).success).toBe(true);
  });

  test("rejects both fields together", () => {
    const parsed = EndTurnArgsSchema.safeParse({ nextWakeIn: 600, wakeAt: 230520 });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe(
      "give nextWakeIn or wakeAt, not both (the turn did not end)",
    );
  });

  test("rejects a negative delay and a fractional time", () => {
    expect(EndTurnArgsSchema.safeParse({ nextWakeIn: -1 }).success).toBe(false);
    expect(EndTurnArgsSchema.safeParse({ wakeAt: 1.5 }).success).toBe(false);
  });
});

test("tool arguments are typed per tool", () => {
  const recruit: ToolArgs<"recruit"> = {
    city: "c3",
    orders: [{ unit: "guard", count: "max" }],
  };
  // @ts-expect-error view_city needs a city id
  const view: ToolArgs<"view_city"> = { city: "p3" };
  expect(TOOL_ARGS.recruit.safeParse(recruit).success).toBe(true);
  expect(TOOL_ARGS.view_city.safeParse(view).success).toBe(false);
});

test("arbitrary inputs never make a tool schema throw (property)", () => {
  fc.assert(
    fc.property(fc.constantFrom(...TOOL_NAMES), fc.anything(), (tool, args) => {
      const schema: ZodType = TOOL_ARGS[tool];
      expect(() => schema.safeParse(args)).not.toThrow();
      expect(() => ToolResultSchema.safeParse(args)).not.toThrow();
    }),
  );
});

test("TOOL_INFO matches the families and kinds of §8.3", () => {
  const families = Object.fromEntries(TOOL_NAMES.map((t) => [t, TOOL_INFO[t].family]));
  expect(families["read_notes"]).toBe("memory");
  expect(TOOL_INFO.read_notes.kind).toBe("read");
  expect(TOOL_INFO.write_note.kind).toBe("gateway");
  expect(TOOL_INFO.end_turn).toEqual({ family: "turn", kind: "gateway" });
  expect(TOOL_NAMES.filter((t) => TOOL_INFO[t].kind === "engine")).toHaveLength(13);
  expect(TOOL_NAMES.filter((t) => TOOL_INFO[t].kind === "read")).toHaveLength(7);
});
