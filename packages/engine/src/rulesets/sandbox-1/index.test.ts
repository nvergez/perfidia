import { describe, expect, test } from "bun:test";
import type { AnyRuleset } from "@perfidia/engine/contracts";
import { fmt, idKeyFromSeed } from "@perfidia/engine/core";
import { createMatch } from "@perfidia/engine/kernel";
import * as sandbox from "@perfidia/engine/rulesets/sandbox-1";
import { addBuildItem, addRecruitBatch } from "@perfidia/engine/testing";
import {
  compareIds,
  DOMAIN_EVENT_KINDS,
  PlayerIdSchema,
  STANDARD_EVENT_TYPES,
  TOOL_NAMES,
  ViolationSchema,
  z,
} from "@perfidia/protocol";
import { sandboxCity, sandboxMatch, sandboxState, TEST_DOMAIN } from "./testkit.test.ts";

// The descriptor `sandbox1_1_0_0` against the ruleset contract (docs/architecture.md §3.2, §3.5,
// §3.7, §3.8), the same-second order of completions, and a whole match through the kernel.

const ruleset = sandbox.sandbox1_1_0_0;

describe("descriptor", () => {
  test("identity and status", () => {
    expect(ruleset.id).toBe("sandbox-1");
    expect(ruleset.version).toBe("1.0.0");
    expect(ruleset.ref).toBe("sandbox-1@1.0.0");
    expect(ruleset.status).toBe("test");
    expect(ruleset.title.length).toBeGreaterThan(0);
    const any: AnyRuleset = ruleset;
    expect(any.ref).toBe(ruleset.ref);
  });

  test("defaults parse with its schema; players 2..12", () => {
    expect(ruleset.configSchema.safeParse(ruleset.defaults).success).toBe(true);
    expect(ruleset.players(ruleset.defaults)).toEqual({ min: 2, max: 12 });
    expect(ruleset.extSchema.safeParse({ hillOpen: false }).success).toBe(true);
    expect(ruleset.extSchema.safeParse({ hillOpen: false, extra: 1 }).success).toBe(false);
  });

  test("event classes cover every kind it schedules, match_end alone in its class", () => {
    const rules = ruleset.compile(ruleset.defaults, 4);
    const kinds = [...DOMAIN_EVENT_KINDS, ...Object.keys(ruleset.hooks.on ?? {})];
    expect(Object.keys(rules.eventClasses).toSorted(compareIds)).toEqual(
      kinds.toSorted(compareIds),
    );
    const end = rules.eventClasses["match_end"];
    expect(
      Object.entries(rules.eventClasses)
        .filter(([, c]) => c === end)
        .map(([kind]) => kind),
    ).toEqual(["match_end"]);
  });

  test("hooks: attack and spy arrivals, hill_open, afterStep, visibility, ext actions, invariants", () => {
    const h = ruleset.hooks;
    expect(Object.keys(h.arrive).toSorted(compareIds)).toEqual(["attack", "spy"]);
    expect(Object.keys(h.on ?? {})).toEqual(["hill_open"]);
    expect(Object.keys(h).toSorted(compareIds)).toEqual([
      "actions",
      "afterStep",
      "arrive",
      "createWorld",
      "finish",
      "invariants",
      "on",
      "standings",
      "travelTime",
      "visibility",
    ]);
    expect(Object.keys(h.actions ?? {})).toEqual(["ext"]);
    expect(Object.keys(h.visibility ?? {}).toSorted(compareIds)).toEqual([
      "movementAccess",
      "publicCity",
      "publicMatch",
    ]);
    expect((h.invariants ?? []).map((i) => i.name)).toEqual([
      "sandbox.hill-timer",
      "sandbox.owned-cities",
      "sandbox.no-hold",
    ]);
  });

  test("extra tools: one read, one write with hooks.actions.ext, no collision, root objects", () => {
    const tools = ruleset.tools ?? [];
    expect(tools.map((t) => [t.name, t.kind, t.family])).toEqual([
      ["hill_status", "read", "observe"],
      ["rename_city", "write", "economy"],
    ]);
    for (const t of tools) {
      expect((TOOL_NAMES as readonly string[]).includes(t.name)).toBe(false);
      expect(t.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(t.description.length).toBeGreaterThan(20);
      const schema = z.toJSONSchema(t.args) as Record<string, unknown>;
      expect(schema["type"]).toBe("object");
      expect(typeof t.read).toBe(t.kind === "read" ? "function" : "undefined");
    }
    expect(ruleset.hooks.actions?.ext).toBeDefined();
  });

  test("event schemas: city_renamed only, not a standard type, no intel event", () => {
    expect(Object.keys(ruleset.eventSchemas)).toEqual(["city_renamed"]);
    expect((STANDARD_EVENT_TYPES as readonly string[]).includes("city_renamed")).toBe(false);
    expect(ruleset.intelEvents).toBeUndefined();
    const schema = ruleset.eventSchemas["city_renamed"];
    expect(schema?.safeParse({ city: "c1", name: "Iron Hold" }).success).toBe(true);
    expect(schema?.safeParse({ city: "c1", name: "Iron/Hold" }).success).toBe(false);
  });

  test("errors: a sample per code, worded with numbers and no placeholder", () => {
    const codes = Object.keys(ruleset.errors);
    expect(codes).toEqual(["CITY_NAME_INVALID"]);
    for (const code of codes) {
      expect(ruleset.errorSamples.some((v) => v.code === code)).toBe(true);
    }
    for (const v of ruleset.errorSamples) {
      expect(ViolationSchema.safeParse(v).success).toBe(true);
      const explain = ruleset.errors[v.code];
      if (explain === undefined) throw new Error(`no explainer for ${v.code}`);
      const { message, hint } = explain(v, fmt);
      expect(message).not.toContain("?");
      expect(hint).not.toContain("?");
      expect(`${message} ${hint}`).toContain("16");
    }
  });

  test("the barrel exports the descriptor and the modules", () => {
    expect(sandbox.SANDBOX_1_REF).toBe("sandbox-1@1.0.0");
    expect(typeof sandbox.compileRules).toBe("function");
    expect(typeof sandbox.createWorld).toBe("function");
    expect(typeof sandbox.resolveBattle).toBe("function");
    expect(typeof sandbox.lootTake).toBe("function");
    expect(typeof sandbox.renderCheatSheet).toBe("function");
  });
});

/** The completion events of a recruit batch and a build item that end in the same second. */
function completions(recruitFirst: boolean): string[] {
  const now = 50000;
  const { state, rules } = sandboxState({ players: 2, now });
  sandboxCity(state, rules, {
    owner: "p1",
    id: "c1",
    island: "i1",
    capital: true,
    buildings: { keep: 2, sawmill: 1, pit: 1, forge: 1, depot: 1, camp: 1 },
  });
  sandboxCity(state, rules, { owner: "p2", id: "c2", island: "i3", capital: true });
  const end = now + 600;
  if (recruitFirst) {
    addRecruitBatch(state, rules, "c1", "spearman", 2, { start: now, unitTime: 300 });
    addBuildItem(state, rules, "c1", "depot", { start: now, end });
  } else {
    addBuildItem(state, rules, "c1", "depot", { start: now, end });
    addRecruitBatch(state, rules, "c1", "spearman", 2, { start: now, unitTime: 300 });
  }
  const match = sandboxMatch(state);
  return match
    .advanceTo(end)
    .events.filter((e) => e.type !== "queue_empty")
    .map((e) => e.type);
}

describe("same-second completions", () => {
  test("a build and a recruit completing in the same second resolve in seq order", () => {
    expect(completions(true)).toEqual(["recruit_done", "build_done"]);
    expect(completions(false)).toEqual(["build_done", "recruit_done"]);
  });
});

describe("a whole match through the kernel", () => {
  test("actions, battles, spies and renames over 7 days keep every step invariant", () => {
    const match = createMatch(
      {
        ruleset: ruleset.ref,
        overrides: { "time.hillOpen": 700000 },
        seed: 42,
        idKey: idKeyFromSeed(42),
        seats: [1, 2, 3, 4].map((i) => ({ id: PlayerIdSchema.parse(`p${i}`) })),
      },
      ruleset,
      TEST_DOMAIN,
      { invariants: "step" },
    );
    expect(
      match.apply("p1", { type: "ext", tool: "rename_city", args: { city: "c1", name: "First" } })
        .ok,
    ).toBe(true);
    expect(
      match.apply("p2", { type: "attack", from: "c2", to: "c1", units: { spearman: 4 } }),
    ).toMatchObject({
      ok: false,
      violation: { code: "ATTACK_PROTECTION" },
    });
    match.advanceTo(21600);
    const attack = match.apply("p2", {
      type: "attack",
      from: "c2",
      to: "c1",
      units: { spearman: 8 },
    });
    expect(attack.ok).toBe(true);
    // 55 gold against 50 + 8 spearmen: the spy fails and p4 learns of it.
    const spy = match.apply("p3", { type: "spy", from: "c3", to: "c4", gold: 55 });
    expect(spy.ok).toBe(true);
    const types = new Set<string>();
    for (const t of [43200, 86400, 300000, 604800]) {
      for (const e of match.advanceTo(t).events) types.add(e.type);
    }
    expect([...types].toSorted(compareIds)).toEqual([
      "battle",
      "battle_report",
      "match_ended",
      "spy_detected",
      "spy_failed",
    ]);
    expect(match.result).toMatchObject({ endedAt: 604800, reason: "time" });
  });
});
