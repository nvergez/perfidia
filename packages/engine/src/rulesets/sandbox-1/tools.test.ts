import { describe, expect, test } from "bun:test";
import { canonicalJson } from "@perfidia/engine/core";
import { addBuildItem, addMovement, addRecruitBatch, addStationed } from "@perfidia/engine/testing";
import { z, type Action, type Json, type Violation } from "@perfidia/protocol";
import { CITY_NAME_INVALID } from "./errors.ts";
import {
  CityRenamedSchema,
  HILL_STATUS_TOOL,
  RENAME_CITY_TOOL,
  RenameCityArgsSchema,
} from "./tools.ts";
import { cityOf, sandboxCity, sandboxMatch, sandboxState, type Overrides } from "./testkit.test.ts";

// The extra tools (docs/architecture.md §3.7, §3.8): `rename_city` through the kernel's `ext`
// action and `hooks.actions.ext`; `hill_status` from public data only.

function rename(args: Json): Action {
  return { type: "ext", tool: "rename_city", args };
}

function world(o: { overrides?: Overrides; hidden?: boolean } = {}) {
  const now = 50000;
  const { state, rules } = sandboxState({ players: 3, now, overrides: o.overrides ?? {} });
  sandboxCity(state, rules, { owner: "p1", id: "c1", island: "i1", capital: true });
  sandboxCity(state, rules, { owner: "p2", id: "c2", island: "i3", capital: true, stock: 100 });
  sandboxCity(state, rules, { owner: "p3", id: "c3", island: "i5", capital: true });
  sandboxCity(state, rules, { owner: "p2", id: "c4", island: "i4" });
  if (o.hidden === true) {
    // Data hidden from p1: p2's units, stock, queues, stationed groups and movements.
    const c2 = state.cities["c2"];
    if (c2 === undefined) throw new Error("no c2");
    c2.units = { spearman: 99, boat: 4 };
    c2.stock = { wood: 777 * 3600, stone: 5 * 3600, gold: 0 };
    state.ledger["p2"] = { made: { spearman: 99, boat: 4 }, gone: {} };
    addBuildItem(state, rules, "c2", "camp", { end: now + 9000 });
    addRecruitBatch(state, rules, "c4", "spearman", 3);
    addStationed(state, "c3", { owner: "p2", home: "c4", role: "support", units: { axeman: 3 } });
    addMovement(state, rules, {
      kind: "spy",
      owner: "p2",
      from: "c2",
      to: "c3",
      gold: 80,
      party: "p3",
      arriveAt: now + 7000,
    });
  }
  return sandboxMatch(state, o.overrides ?? {});
}

describe("rename_city", () => {
  test("renames an own city through the kernel's ext action and emits the public city_renamed", () => {
    const match = world();
    const before = match.hash();
    const out = match.apply("p1", rename({ city: "c1", name: "Iron Hold.2" }));
    expect(out).toEqual({
      ok: true,
      data: { city: "c1", name: "Iron Hold.2" },
      events: [
        {
          t: 50000,
          type: "city_renamed",
          public: true,
          to: [],
          data: { city: "c1", name: "Iron Hold.2" },
        },
      ],
      warnings: [],
    });
    expect(CityRenamedSchema.safeParse(out.ok ? out.events[0]?.data : null).success).toBe(true);
    expect(cityOf(match, "c1").name).toBe("Iron Hold.2");
    expect(match.hash()).not.toBe(before);
    const visibility = match.ruleset.hooks.visibility;
    expect(visibility?.publicCity?.(match.read(), "p2", "c1")).toEqual({ name: "Iron Hold.2" });
    expect(visibility?.publicCity?.(match.read(), "p2", "c2")).toEqual({ name: "c2" });
  });

  test("rejections are violations with flat details, and leave the hash unchanged", () => {
    const match = world();
    const before = match.hash();
    const cases: [Json, string, Violation["details"]][] = [
      [{ city: "c2", name: "Mine" }, "NOT_OWNER", { city: "c2" }],
      [{ city: "c99", name: "Mine" }, "UNKNOWN_ID", { city: "c99" }],
      [
        { city: "c1", name: "A name of 17 char" },
        CITY_NAME_INVALID,
        { city: "c1", reason: "length", length: 17, max: 16 },
      ],
      [
        { city: "c1", name: "" },
        CITY_NAME_INVALID,
        { city: "c1", reason: "length", length: 0, max: 16 },
      ],
      [
        { city: "c1", name: "Café" },
        CITY_NAME_INVALID,
        { city: "c1", reason: "characters", length: 4, max: 16 },
      ],
      [
        { city: "c1", name: "a/b" },
        CITY_NAME_INVALID,
        { city: "c1", reason: "characters", length: 3, max: 16 },
      ],
      [{ city: "c1" }, "INVALID_ARGS", { tool: "rename_city", field: "name" }],
      [{ city: "c1", name: "Ok", extra: 1 }, "INVALID_ARGS", { tool: "rename_city", field: null }],
      [{ city: "x1", name: "Ok" }, "INVALID_ARGS", { tool: "rename_city", field: "city" }],
    ];
    for (const [args, code, details] of cases) {
      const out = match.apply("p1", rename(args));
      expect(out).toEqual({ ok: false, violation: { code, details } });
    }
    expect(match.apply("p1", { type: "ext", tool: "hill_status", args: {} })).toEqual({
      ok: false,
      violation: { code: "INVALID_ARGS", details: { tool: "hill_status", reason: "unknown_tool" } },
    });
    expect(match.hash()).toBe(before);
  });

  test("the maximum length follows names.cityMaxChars", () => {
    const match = world({ overrides: { "names.cityMaxChars": 4 } });
    expect(match.apply("p1", rename({ city: "c1", name: "Fort" })).ok).toBe(true);
    expect(match.apply("p1", rename({ city: "c1", name: "Forts" }))).toEqual({
      ok: false,
      violation: {
        code: CITY_NAME_INVALID,
        details: { city: "c1", reason: "length", length: 5, max: 4 },
      },
    });
  });

  test("the tool's arguments are one root object, and match the protocol name schema", () => {
    for (const tool of [RENAME_CITY_TOOL, HILL_STATUS_TOOL]) {
      const schema = z.toJSONSchema(tool.args) as Record<string, unknown>;
      expect(schema["type"]).toBe("object");
      expect(schema["anyOf"] ?? schema["oneOf"] ?? schema["allOf"]).toBeUndefined();
    }
    expect(RENAME_CITY_TOOL).toMatchObject({ kind: "write", family: "economy" });
    expect(HILL_STATUS_TOOL).toMatchObject({ kind: "read", family: "observe" });
    expect(RenameCityArgsSchema.safeParse({ city: "c1", name: "Iron Hold" }).success).toBe(true);
    expect(RenameCityArgsSchema.safeParse({ city: "c1", name: "Café" }).success).toBe(false);
    expect(RenameCityArgsSchema.safeParse({ city: "c1" }).success).toBe(false);
  });
});

/** `hill_status` as the gateway calls it. */
function readStatus(match: ReturnType<typeof world>, seat: "p1" | "p2" = "p1") {
  const tool = HILL_STATUS_TOOL;
  if (tool.read === undefined) throw new Error("hill_status has no read");
  return tool.read(match.read(), seat, {});
}

describe("hill_status", () => {
  test("answers the hill status", () => {
    const match = world();
    expect(readStatus(match)).toEqual({
      open: false,
      opensAt: [172800, "D3 00:00"],
      threshold: 2,
      totalCities: 4,
      leaders: [
        { player: "p2", cities: 2 },
        { player: "p1", cities: 1 },
        { player: "p3", cities: 1 },
      ],
    });
  });

  test("reads public data only: hidden data changes nothing, for any seat", () => {
    const plain = world();
    const hidden = world({ hidden: true });
    hidden.checkInvariants("checkpoint");
    for (const seat of ["p1", "p2"] as const) {
      expect(canonicalJson(readStatus(hidden, seat))).toBe(canonicalJson(readStatus(plain, seat)));
    }
  });

  test("never writes: the state is byte-identical after a read", () => {
    const match = world({ hidden: true });
    const before = canonicalJson(match.read().state);
    readStatus(match);
    expect(canonicalJson(match.read().state)).toBe(before);
  });
});
