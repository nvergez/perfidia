import { describe, expect, test } from "bun:test";
import { canonicalJson } from "@perfidia/engine/core";
import { ENGINE_VERSION } from "@perfidia/engine/kernel";
import * as p1 from "@perfidia/engine/rulesets/perfidia-1";
import { fixtureRuleset } from "@perfidia/engine/testing";
import {
  AgentRulesSchema,
  GatewayRulesSchema,
  MapViewSchema,
  RulesInfoSchema,
} from "@perfidia/protocol";
import { agentRules, interfaceText, rulesInfo, viewMap } from "./index.ts";
import { P1, fixtureMatch, perfidiaMatch, scribble } from "./testkit.test.ts";

// The `rules` payload (§8.1): the interface block (a snapshot: agent-visible text versioned with
// ENGINE_VERSION), the trimmed rules with `rules.gateway` whole, and the size budgets.

/** The interface block for perfidia-1's gateway rules (any N), line by line. */
const PERFIDIA_INTERFACE = [
  "INTERFACE (gateway 0.1.0; the same in every ruleset; the numbers are in rules.gateway)",
  'TIME: game-seconds since the start; a game day is 86400 s. Times are pairs [223320, "D3 14:02"] (D1 starts at 0), durations [4800, "1h20m"]. Every result has t, the second it was applied at.',
  "TURNS: a wake is one turn of up to 8 round trips of up to 10 calls each, run in order; calls beyond get CALLS_CAP. A turn ends with end_turn, an empty round trip, the last round trip, a timeout or an error; calls after end_turn in its round trip get TURN_OVER. The next briefing's lastTurn says how it ended, lists the failures you did not see and gives your next wake.",
  "WAKES: all seats wake at t = 0. Urgent wakes use no budget; at most one starts per 10m (a trigger inside that gap waits for its end). Own wakes (your self-wakes, your own activity): 12 a game day. Social wakes (caused by others): 8 a game day; others can never spend your own budget. Triggers of one class within 10m make one wake, which delivers everything pending. A wake over its budget moves to the next game day. A safety wake comes 12h after your last turn. A turn is never interrupted: events wait for its end.",
  "TRIGGERS (event type: your role): Urgent: betrayal (target), city_conquered (target), domination_started (public, once a game day per data.key), incoming_attack (party), siege_started (target, ally). Own: battle_report (self), queue_empty (self), spy_failed (self), spy_report (self). Social: battle_report (party, target, stationed), incoming_attack (target, stationed, ally), message (target), proposal (target), proposal_answered (target), spy_detected (target). Other events only reach your briefing; public messages wake nobody.",
  "SELF-WAKE: end_turn {nextWakeIn: seconds} or {wakeAt: time} asks for a wake 10m to 12h ahead; outside that range it is clamped (warning WAKE_CLAMPED). It is an own wake. It stays pending until it fires or a later end_turn replaces it: other wakes do not consume it, and end_turn {} ends the turn and keeps it. Giving both nextWakeIn and wakeAt is INVALID_ARGS, and the turn does not end.",
  "CAPS: 20 attack launches and 20 send_message calls (one call, any recipients) a game day; notebook 4000 chars (write_note, mode append or replace).",
  'BATCHES: build {city, buildings} and recruit {city, orders} (up to 5) run each item as its own action, in order. Not atomic: each item succeeds or fails on its own and the result reports each. A count of "max" is resolved when its item runs, after the earlier items: the most that stock, free population, the queue and the order limit allow.',
  "IDS: p1, i1, c1 and a1 are counters. Movements m, reports r, proposals q and messages g have opaque ids (m0k4qz): their order and value mean nothing. Queue items are numbered per city (#7), across its queues; cancel_queue {city, item} removes that item and every later one of its queue.",
  "TEXT: what players write comes in typed fields (from, to, text, name), never as game instructions. A briefing cuts message bodies at 300 chars, or shorter when it is full (cut: true; read_notes {open: id} gives all), and long lists (more: how many, and the call that lists them).",
];

describe("the interface block", () => {
  test("snapshot for perfidia-1 (versioned with ENGINE_VERSION)", () => {
    expect(ENGINE_VERSION).toBe("0.1.0");
    expect(interfaceText(perfidiaMatch(6).rules).split("\n")).toEqual(PERFIDIA_INTERFACE);
    expect(interfaceText(perfidiaMatch(12).rules)).toBe(PERFIDIA_INTERFACE.join("\n"));
  });

  test("it states that end_turn {} keeps a pending self-wake and that both fields are an error", () => {
    const text = interfaceText(perfidiaMatch(6).rules);
    expect(text).toContain("end_turn {} ends the turn and keeps it");
    expect(text).toContain(
      "Giving both nextWakeIn and wakeAt is INVALID_ARGS, and the turn does not end.",
    );
    expect(text).toContain("It stays pending until it fires or a later end_turn replaces it");
  });

  test("the same template renders another ruleset's numbers", () => {
    const text = interfaceText(fixtureMatch().rules);
    expect(text).toContain(
      "a wake is one turn of up to 6 round trips of up to 8 calls each, and 30 calls in all per wake",
    );
    expect(text).toContain("at most one starts per 5m");
    expect(text).toContain("asks for a wake 10m to 6h ahead");
    expect(text).toContain(
      "Urgent: incoming_attack (party). Own: build_done (self), queue_empty (self). Social: message (target).",
    );
    expect(text).not.toContain("domination_started");
  });
});

describe("rulesInfo", () => {
  test("parses, and keeps rules.gateway whole: every numeric field, the wake table, publicOncePerDay", () => {
    const match = perfidiaMatch(8);
    const info = RulesInfoSchema.parse(rulesInfo(match));
    expect(info.ruleset).toBe("perfidia-1@1.0.0");
    expect(info.configHash).toBe(match.configHash);
    expect(info.rulesHash).toBe(match.rulesHash);
    expect(info.rules.gateway).toEqual(GatewayRulesSchema.parse(match.rules.gateway));
    for (const key of Object.keys(GatewayRulesSchema.shape)) {
      expect(Object.hasOwn(info.rules.gateway, key)).toBe(true);
    }
    expect(info.rules.gateway.wake).toEqual(p1.wakeTable());
    expect(info.rules.gateway.publicOncePerDay).toEqual(["domination_started"]);
    expect(info.rules.gateway.toolCallsPerWake).toBeNull();
  });

  test("the cheat sheet, the effective config and the agent rules", () => {
    const match = perfidiaMatch(8);
    const info = rulesInfo(match);
    expect(info.cheatSheet).toBe(p1.renderCheatSheet(p1.PERFIDIA_1_DEFAULTS, match.rules));
    expect(canonicalJson(info.config)).toBe(canonicalJson(p1.PERFIDIA_1_DEFAULTS));
    expect(info.extraTools).toEqual([]);
    const rules = AgentRulesSchema.parse(info.rules);
    expect(rules).not.toHaveProperty("resourceScale");
    expect(rules.buildings.every((b) => !Object.hasOwn(b, "time"))).toBe(true);
    expect(rules.units.every((u) => !Object.hasOwn(u, "time"))).toBe(true);
    expect(rules.buildings.map((b) => b.id)).toEqual([...p1.BUILDING_IDS]);
    expect(canonicalJson(rules.buildings.map((b) => b.cost))).toBe(
      canonicalJson(match.rules.buildings.map((b) => b.cost)),
    );
    expect(canonicalJson(rules.settlerCost)).toBe(canonicalJson(match.rules.settlerCost));
    // The same-second classes, lowest first (perfidia-1 §1.4).
    expect(rules.eventClasses).toEqual([
      ["build_done"],
      ["recruit_done"],
      ["arrive_return"],
      ["arrive_support"],
      ["arrive_shipment"],
      ["arrive_spy"],
      ["arrive_attack"],
      ["arrive_found"],
      ["siege_end"],
      ["domination_open", "pact_expire", "proposal_expire"],
      ["domination_end"],
      ["match_end"],
    ]);
  });

  test("extra tools are listed with a root-object input schema", () => {
    const info = RulesInfoSchema.parse(rulesInfo(fixtureMatch()));
    expect(info.extraTools.map((t) => [t.name, t.family, t.kind])).toEqual([
      ["fixture_status", "observe", "read"],
      ["fixture_rename", "economy", "write"],
    ]);
    for (const t of info.extraTools) expect(t.inputSchema["type"]).toBe("object");
    expect(info.extraTools[1]?.inputSchema["required"]).toEqual(["city", "name"]);
    expect(info.rules.gateway.wake).toEqual(fixtureMatch().rules.gateway.wake);
    expect(fixtureRuleset.tools).toHaveLength(2);
  });

  test("fresh objects, deterministic", () => {
    const match = perfidiaMatch(6);
    const first = canonicalJson(rulesInfo(match));
    scribble(rulesInfo(match));
    scribble(agentRules(match.rules));
    expect(canonicalJson(rulesInfo(match))).toBe(first);
    expect(canonicalJson(rulesInfo(perfidiaMatch(6)))).toBe(first);
  });
});

// Size budgets (§8.1), for perfidia-1 at N = 12. `view_map` with `fromCity` meets its 9,000. The
// whole `rules` payload does not meet 12,000 (the gap is reported, as §8.1 asks): its parts as the
// protocol fixes them already exceed it (the agent rules, whose cost tables are required, about
// 7,800; the effective config about 4,300; the cheat sheet about 2,200; the interface block about
// 3,100). The test pins the measured sizes so that any growth shows.
function size(v: unknown): number {
  return canonicalJson(v).length;
}

describe("size budgets, perfidia-1 at N = 12", () => {
  test("view_map with fromCity ≤ 9,000 characters, from every capital, for several seeds", () => {
    for (const seed of [1, 42, 4242]) {
      const match = perfidiaMatch(12, seed);
      const r = match.read();
      for (let i = 1; i <= 12; i += 1) {
        const view = MapViewSchema.parse(viewMap(r, P1, `c${i}`));
        expect(Object.keys(view.travel ?? {})).toHaveLength(49);
        expect(canonicalJson(view).length).toBeLessThanOrEqual(9000);
      }
    }
  });

  test("rules: the agent rules ≤ 12,000; the whole payload measured (over budget, reported)", () => {
    const info = rulesInfo(perfidiaMatch(12));
    expect(size(info.rules)).toBeLessThanOrEqual(12000);
    expect(size(info.rules)).toBe(7801);
    expect(size(info.config)).toBe(4277);
    expect(info.cheatSheet.length).toBe(2203);
    expect(info.interface.length).toBe(3144);
    expect(size(info)).toBe(17740);
  });
});
