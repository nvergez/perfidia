// The tool registry (docs/architecture.md §3.7, §7.2, §8.3): the 22 tools plus the ruleset's extras,
// `toolDefinitions` (a snapshot: agent-visible text versioned with ENGINE_VERSION), layers 2–4
// (schema, unsupported options, ids and fog, caps), and P12: fuzzed arguments always give a
// schema-valid result, never an exception.

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { createMatch, type AnyRuleset } from "@perfidia/engine";
import { canonicalJson, sha256Hex } from "@perfidia/engine/core";
import { ENGINE_VERSION, type Match } from "@perfidia/engine/kernel";
import { gatewayRulesCopy } from "@perfidia/gateway/present";
import {
  createGatewayState,
  createWakeScheduler,
  deliver,
  type GatewayState,
  type WakeScheduler,
} from "@perfidia/gateway/seat";
import {
  TOOL_NAMES,
  TOOL_RESULT_DATA,
  ToolResultSchema,
  type PlayerId,
  type ToolName,
  type ToolResult,
} from "@perfidia/protocol";
import {
  TOOL_DESCRIPTIONS,
  createToolRegistry,
  invokeTool,
  toolDefinitions,
  type CallOutcome,
  type ToolEnv,
} from "./index.ts";
import { PERFIDIA, SANDBOX, call, setupOf } from "./testkit.test.ts";

/** A seat's tool environment on a live match, without a log: what the host does, minus the lines. */
class Bench {
  readonly match: Match;
  readonly gw: GatewayState;
  readonly wake: WakeScheduler;
  submitted = 0;

  constructor(ruleset: AnyRuleset, players: number, overrides: Record<string, number> = {}) {
    const setup = setupOf(ruleset, players, overrides);
    this.match = createMatch(setup, ruleset, { invariants: "step" });
    this.gw = createGatewayState(setup.seats.map((s) => s.id));
    this.wake = createWakeScheduler(this.gw, gatewayRulesCopy(this.match.rules.gateway));
  }

  env(seat: PlayerId): ToolEnv {
    return {
      match: this.match,
      seat,
      gw: this.gw,
      wake: this.wake,
      turn: { index: 1, round: 0, call: 0 },
      submit: (a) => {
        this.submitted += 1;
        const out = this.match.apply(seat, a);
        if (out.ok) deliver(this.gw, out.events, this.wake);
        return out;
      },
      note: () => undefined,
      endTurn: () => undefined,
    };
  }

  run(seat: PlayerId, tool: string, args: unknown = {}): CallOutcome {
    return invokeTool(createToolRegistry(this.match.ruleset), this.env(seat), call(tool, args));
  }
}

function isToolName(s: string): s is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(s);
}

function failure(r: ToolResult): { code: string; message: string; details?: unknown } {
  if (r.ok) throw new Error(`expected a failure, got ${canonicalJson(r)}`);
  return r;
}

/** The descriptions of the 22 tools, verbatim (agent-visible text, versioned with ENGINE_VERSION). */
const EXPECTED_DESCRIPTIONS: Readonly<Record<ToolName, string>> = {
  view_city:
    "View one city. Your own and allied cities in full: stock, production rates, storage cap, population, buildings, build and recruit queues with their item numbers and end times, units at home, stationed groups and the movements you can see arriving or leaving. Any other city: its public fields and the latest spy or battle report you hold about it, with its age.",
  view_island:
    "View one island: kind, coordinates, richness, slots with the cities on them and the free ones, and the travel time from each of your cities for every travel group of the rules.",
  view_map:
    "Every island and city with their public fields. With fromCity (one of your cities), also the travel time from it to every island for every travel group of the rules.",
  view_player:
    "A player's public profile: cities, score and its public parts, relations (allies and pacts) and its relation to you. On yourself it adds your movements, your groups stationed in other cities, your founding-unit count and the next founding-unit cost, your open proposals, today's counters and your pending self-wake.",
  leaderboard:
    "The standings: rank, score and its public parts, cities and alive status of every player, with alliances and relations, plus the match-wide public state of the ruleset (for example running countdowns).",
  rules:
    "The rules of this match: how turns, wakes, caps, batches, times and ids work (interface), the ruleset's cheat sheet, the effective config, the compiled tables (costs, times, levels, units, queues, movement and diplomacy limits, gateway caps and wake rules) and the ruleset's extra tools. They never change during a match.",
  build:
    "Queue buildings in one of your cities, in order. Each item is its own action and succeeds or fails on its own (not atomic); the result reports each item: its queue item number, target level, cost paid and end time, or why it failed. At most the build queue's length (rules.queues.build.max) items per call.",
  recruit:
    'Recruit units in one of your cities: up to 5 orders {unit, count}, applied in order, each succeeding or failing on its own (not atomic). count "max" recruits the most possible when that order runs, after the earlier ones: limited by stock, free population, the queue and the per-order limit. Each order\'s result gives its queue item number, the count, the cost and the end time.',
  cancel_queue:
    "Cancel queue item #item of one of your cities together with every later item of the same queue. Refunds follow rules.queues.refund, capped by storage.",
  send_resources:
    "Ship wood, stone and gold from one of your cities to another city, yours or another player's. The cargo leaves your stock now and arrives after the travel time; what the destination's storage cannot hold is lost. In-flight cargo per city may be capped (rules.movement.shipment).",
  attack:
    "Send units from one of your cities to attack a city. The target and the foe you fight are fixed at launch. Counts against your attack launches per game day. A movement can be turned back within the recall window (rules.movement.recall).",
  support:
    "Send units from one of your cities to defend another city, where they stay stationed until recalled or dismissed.",
  spy: "Send gold from one of your cities to spy on a city (at least rules.movement.spyMinGold). The report or the failure notice comes back when it arrives.",
  recall_troops:
    "Exactly one mode per call. {movement}: turn one of your movements back within its recall window. {stationedAt, home?, units?}: bring your units stationed in a city home: all of them, the group from one home city, or part of it, as the rules allow. {dismiss: {city, player}}: send a player's support group in your city home.",
  found_city:
    "Send units, including the founding unit of the rules (rules.roles), from one of your cities to found a new city on an island with a free slot. slot is accepted only when rules.toolOptions.foundSlot allows choosing it; otherwise the lowest free slot at arrival is used.",
  send_message:
    'Send a message to a list of players (private: only they and you see it) or to "all" (public: in everyone\'s news; it wakes nobody). Counts once against your messages per game day, whatever the recipients. Nothing written is binding.',
  propose_alliance:
    "Propose an alliance (kind alliance; name names a new alliance) or a non-aggression pact (kind pact) to a player, with an optional text. It expires after rules.diplomacy.proposalTtl; limits are checked again when it is accepted. until (a pact end) is accepted only when rules.toolOptions.pactUntil allows it. Nothing is binding.",
  answer_proposal:
    "Accept or refuse an open proposal addressed to you; its id is in your briefing. Limits are checked when you accept.",
  leave_alliance:
    "Without with: leave your alliance. With a pact partner: end that pact. With an ally: leave the alliance.",
  write_note:
    "Write your notebook, which every briefing shows verbatim: mode append adds a line, mode replace rewrites it. At most rules.gateway.notesMaxChars characters.",
  read_notes:
    "Without arguments: your notebook. search looks through your archive (scope mine), the public feed (public) or both (all, the default), filtered by case-insensitive text, event kinds, a counterpart player and a time range, newest first, at most 20 hits. open returns one full message or report by its id.",
  end_turn:
    "End your turn. nextWakeIn (seconds ahead) or wakeAt (a game time), at most one, sets your self-wake: it is clamped into rules.gateway.selfWake (warning WAKE_CLAMPED) and stays pending until it fires or a later end_turn replaces it. end_turn {} keeps any pending self-wake. Calls after end_turn in the same round trip are not run.",
};

describe("toolDefinitions", () => {
  test("exactly the 22 tools in TOOL_NAMES order, then the ruleset's extras (two for sandbox-1)", () => {
    expect(toolDefinitions(PERFIDIA).map((d) => d.name)).toEqual([...TOOL_NAMES]);
    expect(toolDefinitions(SANDBOX).map((d) => d.name)).toEqual([
      ...TOOL_NAMES,
      "hill_status",
      "rename_city",
    ]);
    expect(createToolRegistry(SANDBOX).size).toBe(24);
  });

  test("every inputSchema is a root object, with no root anyOf, oneOf or allOf", () => {
    for (const rs of [PERFIDIA, SANDBOX]) {
      for (const d of toolDefinitions(rs)) {
        expect(d.inputSchema["type"]).toBe("object");
        for (const key of ["anyOf", "oneOf", "allOf"])
          expect(Object.hasOwn(d.inputSchema, key)).toBe(false);
      }
    }
  });

  test("snapshot: the gateway's descriptions are the same in every ruleset; extras keep the ruleset's", () => {
    expect(ENGINE_VERSION).toBe("0.1.0");
    const perfidia = toolDefinitions(PERFIDIA);
    const sandbox = toolDefinitions(SANDBOX);
    for (const name of TOOL_NAMES) {
      const d = perfidia.find((x) => x.name === name);
      expect(d?.description).toBe(TOOL_DESCRIPTIONS[name]);
      expect(sandbox.find((x) => x.name === name)).toEqual(d);
    }
    expect(sandbox.at(-1)?.description).toBe(SANDBOX.tools?.[1]?.description);
    expect(TOOL_DESCRIPTIONS).toEqual(EXPECTED_DESCRIPTIONS);
    // The whole definitions, schemas included: a change here changes what agents are handed.
    expect(sha256Hex(canonicalJson(perfidia))).toBe(
      "f80f22e26d904451d00df2f3bd59e7ac36e34ca9447713d19f5e0b9d8d8d8f4e",
    );
    expect(sha256Hex(canonicalJson(sandbox))).toBe(
      "cc38c6307f04e023c60395a167873aa7fe9017362b9a70f4bb43ad987335f087",
    );
    expect(perfidia.find((d) => d.name === "end_turn")).toEqual({
      name: "end_turn",
      description: TOOL_DESCRIPTIONS.end_turn,
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          nextWakeIn: { type: "integer", minimum: 0, maximum: 9007199254740991 },
          wakeAt: { type: "integer", minimum: 0, maximum: 9007199254740991 },
        },
        additionalProperties: false,
      },
    });
  });
});

describe("layers 2–4", () => {
  test("an unknown tool and arguments failing the schema are INVALID_ARGS logged as gw lines", () => {
    const b = new Bench(SANDBOX, 2);
    const unknown = b.run("p1", "teleport", {});
    expect(unknown.line).toBe("gw");
    expect(failure(unknown.result)).toMatchObject({
      code: "INVALID_ARGS",
      details: { tool: "teleport", reason: "no_handler" },
      message: "teleport is not available in sandbox-1@1.0.0.",
    });
    const bad = b.run("p1", "attack", { from: "c1", to: "c2", units: { spearman: 0 } });
    expect(bad.line).toBe("gw");
    expect(failure(bad.result)).toMatchObject({
      code: "INVALID_ARGS",
      details: { path: "units.spearman" },
    });
    const extra = b.run("p1", "end_turn", { nextWakeIn: 1, extra: true });
    expect(failure(extra.result).code).toBe("INVALID_ARGS");
    expect(b.submitted).toBe(0);
  });

  test("an optional field the ruleset does not accept is INVALID_ARGS naming the ruleset (§3.7)", () => {
    const p = new Bench(PERFIDIA, 6);
    const slot = p.run("p1", "found_city", { from: "c1", island: "i1", units: {}, slot: 1 });
    expect(slot.line).toBe("gw");
    expect(failure(slot.result)).toMatchObject({
      code: "INVALID_ARGS",
      details: { field: "slot", ruleset: "perfidia-1@1.0.0", reason: "unsupported" },
      message:
        "perfidia-1@1.0.0 does not accept slot: it always founds a city in the lowest free slot.",
    });
    const until = p.run("p1", "propose_alliance", { to: "p2", kind: "pact", until: 90000 });
    expect(failure(until.result).details).toMatchObject({ field: "until", reason: "unsupported" });
    expect(p.submitted).toBe(0);
    // sandbox-1 accepts slot: the call reaches the engine.
    const s = new Bench(SANDBOX, 2);
    s.run("p1", "found_city", { from: "c1", island: "i1", units: {}, slot: 1 });
    expect(s.submitted).toBe(1);
  });

  test("ids: unknown ids, cities of others, and another player's movement reads like a missing one", () => {
    const b = new Bench(SANDBOX, 2);
    expect(failure(b.run("p1", "view_city", { city: "c99" }).result)).toMatchObject({
      code: "UNKNOWN_ID",
      details: { city: "c99" },
    });
    expect(failure(b.run("p1", "build", { city: "c2", buildings: ["keep"] }).result)).toMatchObject(
      {
        code: "NOT_OWNER",
        details: { city: "c2", owner: "p2" },
      },
    );
    expect(failure(b.run("p1", "view_player", { player: "p9" }).result).code).toBe("UNKNOWN_ID");
    // p2 sends a spy: p1 cannot recall it, and the answer is the one a missing movement gets.
    const spy = b.run("p2", "spy", { from: "c2", to: "c1", gold: 60 });
    expect(spy.result.ok).toBe(true);
    if (!spy.result.ok) return;
    const id = spy.result.data["movement"];
    if (typeof id !== "string") throw new Error("no movement id");
    const hidden = failure(b.run("p1", "recall_troops", { movement: id }).result);
    const missing = failure(b.run("p1", "recall_troops", { movement: "m00000" }).result);
    expect(hidden.code).toBe("UNKNOWN_ID");
    expect(canonicalJson(hidden).replaceAll(id, "ID")).toBe(
      canonicalJson(missing).replaceAll("m00000", "ID"),
    );
    expect(b.submitted).toBe(1);
  });

  test("a build batch longer than the build queue is INVALID_ARGS", () => {
    const b = new Bench(SANDBOX, 2);
    const r = b.run("p1", "build", {
      city: "c1",
      buildings: ["keep", "pit", "forge", "depot", "keep"],
    });
    expect(failure(r.result)).toMatchObject({
      code: "INVALID_ARGS",
      details: { path: "buildings", issue: "5 items; the build queue holds at most 4" },
    });
  });

  test("read tools answer with fresh data and an obs line; write_note and end_turn log nothing themselves", () => {
    const b = new Bench(SANDBOX, 2);
    const map = b.run("p1", "view_map", {});
    expect(map.line).toBe("obs");
    expect(map.args).toEqual({});
    const notes = b.run("p1", "read_notes", { search: { text: "x" } });
    expect(notes.result).toMatchObject({ ok: true, data: { notes: "", hits: [], more: false } });
    const open = b.run("p1", "read_notes", { open: "g00000" });
    expect(failure(open.result)).toMatchObject({
      code: "UNKNOWN_ID",
      details: { message: "g00000" },
    });
    expect(b.run("p1", "write_note", { text: "x", mode: "append" }).line).toBeNull();
    expect(b.run("p1", "write_note", { text: "y".repeat(3000), mode: "replace" }).line).toBe("gw");
    const extra = b.run("p1", "hill_status", {});
    expect(extra).toMatchObject({ line: "obs", result: { ok: true, data: { open: false } } });
  });
});

describe("P12: fuzzed arguments always give a schema-valid ToolResult", () => {
  const KEYS = [
    "city",
    "island",
    "fromCity",
    "player",
    "buildings",
    "orders",
    "item",
    "from",
    "to",
    "wood",
    "stone",
    "gold",
    "units",
    "movement",
    "stationedAt",
    "home",
    "dismiss",
    "slot",
    "text",
    "kind",
    "name",
    "until",
    "id",
    "accept",
    "with",
    "mode",
    "search",
    "open",
    "nextWakeIn",
    "wakeAt",
  ];
  const ids = fc.constantFrom(
    "c1",
    "c2",
    "c3",
    "c99",
    "i1",
    "i2",
    "p1",
    "p2",
    "p3",
    "m00000",
    "g00000",
    "constructor",
    "__proto__",
    "",
  );
  const value = fc.oneof(
    ids,
    fc.integer({ min: -5, max: 100000 }),
    fc.constantFrom(
      "max",
      "all",
      "append",
      "replace",
      "pact",
      "alliance",
      "keep",
      "spearman",
      "guard",
      "hall",
    ),
    fc.dictionary(
      fc.constantFrom("spearman", "axeman", "boat", "guard", "raider", "x"),
      fc.integer({ min: -2, max: 50 }),
    ),
    fc.array(
      fc.oneof(
        ids,
        fc.record({
          unit: fc.constantFrom("spearman", "guard"),
          count: fc.oneof(fc.constant("max"), fc.integer({ min: 0, max: 20 })),
        }),
      ),
    ),
    fc.anything(),
  );
  const args = fc.oneof(
    fc.anything(),
    fc.dictionary(fc.constantFrom(...KEYS), value, { maxKeys: 5 }),
  );

  for (const [rs, players] of [
    [SANDBOX, 3],
    [PERFIDIA, 6],
  ] as const) {
    test(`${rs.ref}: every tool, extras and an unknown name included`, () => {
      const b = new Bench(
        rs,
        players,
        rs === PERFIDIA ? { "start.capital.buildings.barracks": 1 } : {},
      );
      const tools = [...createToolRegistry(rs).keys(), "no_such_tool"];
      fc.assert(
        fc.property(
          fc.constantFrom(...tools),
          args,
          fc.constantFrom<PlayerId>("p1", "p2"),
          (tool, a, seat) => {
            const out = b.run(seat, tool, a);
            ToolResultSchema.parse(out.result);
            if (out.result.ok && isToolName(tool)) TOOL_RESULT_DATA[tool].parse(out.result.data);
            expect(out.result.ok || out.result.code !== "INTERNAL").toBe(true);
          },
        ),
        { numRuns: 400 },
      );
    });
  }
});
