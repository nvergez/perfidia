import { describe, expect, test } from "bun:test";
import { checkRules } from "@perfidia/engine/kernel";
import {
  compileRules as compilePerfidia,
  PERFIDIA_1_DEFAULTS,
} from "@perfidia/engine/rulesets/perfidia-1";
import { CompiledRulesSchema, type CompiledRules } from "@perfidia/protocol";
import { compileRules, eventClasses, wakeTable } from "./compile.ts";
import { SANDBOX_1_DEFAULTS, SANDBOX_1_REF } from "./config.ts";
import { sandboxRules } from "./testkit.test.ts";

// The compile output of sandbox-1 (docs/architecture.md §3.8), field by field, and how it differs
// from perfidia-1 wherever core, gateway or bot code could quietly hard-code a perfidia-1 value.
// (Test-only import of perfidia-1: the sources of sandbox-1 import no other ruleset, which
// `packages/sim/src/architecture.test.ts` enforces.)

const rules = compileRules(SANDBOX_1_DEFAULTS, 6);
const perfidia: CompiledRules = compilePerfidia(PERFIDIA_1_DEFAULTS, 6);

function table<T extends { id: string }>(list: readonly T[], id: string): T {
  const found = list.find((x) => x.id === id);
  if (found === undefined) throw new Error(`no ${id}`);
  return found;
}

describe("every N in 2..12", () => {
  test("compiles to valid rules that pass the generic checks", () => {
    for (let n = 2; n <= 12; n += 1) {
      const r = compileRules(SANDBOX_1_DEFAULTS, n);
      expect(CompiledRulesSchema.safeParse(r).success).toBe(true);
      expect(checkRules(r)).toEqual([]);
      expect(r.players).toBe(n);
      expect(r.ruleset).toBe(SANDBOX_1_REF);
      // Nothing but N depends on N: the alliance cap is independent of it.
      expect({ ...r, players: 6 }).toEqual(rules);
    }
  });

  test("is pure: two calls give equal, unshared objects", () => {
    const a = compileRules(SANDBOX_1_DEFAULTS, 4);
    const b = compileRules(SANDBOX_1_DEFAULTS, 4);
    expect(a).toEqual(b);
    expect(a.buildings).not.toBe(b.buildings);
    expect(a.gateway.wake).not.toBe(b.gateway.wake);
  });
});

describe("tables", () => {
  test("buildings: ids, max level 8, cost 30L/30L/10L, time 600·L, camp and docks need keep 2", () => {
    expect(rules.buildings.map((b) => b.id)).toEqual([
      "keep",
      "sawmill",
      "pit",
      "forge",
      "depot",
      "camp",
      "docks",
    ]);
    for (const b of rules.buildings) {
      expect(b.maxLevel).toBe(8);
      expect(b.cost[3]).toEqual({ wood: 90, stone: 90, gold: 30 });
      expect(b.cost[8]).toEqual({ wood: 240, stone: 240, gold: 80 });
      expect(b.time.map((row) => row)).toEqual([
        [1],
        ...[1, 2, 3, 4, 5, 6, 7, 8].map((L) => [600 * L]),
      ]);
      expect(b.requires).toEqual(b.id === "camp" || b.id === "docks" ? { keep: 2 } : {});
    }
  });

  test("units: stats, queues, requirements, flat times, orders of 300 (colonists 1)", () => {
    expect(rules.units.map((u) => u.id)).toEqual(["spearman", "axeman", "colonist", "boat"]);
    const spearman = table(rules.units, "spearman");
    expect(spearman).toMatchObject({
      domain: "land",
      attack: 5,
      defense: 15,
      naval: 0,
      carry: 10,
      capacity: 0,
      pop: 1,
      cost: { wood: 20, stone: 30, gold: 20 },
      queue: "camp",
      requires: { camp: 1 },
      maxPerOrder: 300,
    });
    expect(table(rules.units, "axeman")).toMatchObject({
      attack: 15,
      defense: 5,
      carry: 25,
      pop: 1,
      cost: { wood: 30, stone: 20, gold: 25 },
      requires: { camp: 1 },
    });
    expect(table(rules.units, "colonist")).toMatchObject({
      domain: "land",
      attack: 0,
      defense: 0,
      carry: 0,
      pop: 5,
      queue: "camp",
      requires: { camp: 2 },
      maxPerOrder: 1,
    });
    expect(table(rules.units, "boat")).toMatchObject({
      domain: "naval",
      attack: 0,
      defense: 0,
      naval: 0,
      capacity: 15,
      pop: 2,
      cost: { wood: 100, stone: 30, gold: 50 },
      queue: "docks",
      requires: { docks: 1 },
      maxPerOrder: 300,
    });
    for (const u of rules.units) {
      expect(u.time).toHaveLength(9);
      expect(new Set(u.time).size).toBe(1);
    }
    expect(table(rules.units, "spearman").time[0]).toBe(240);
    expect(table(rules.units, "colonist").time[5]).toBe(3600);
    expect(table(rules.units, "boat").time[8]).toBe(900);
    // No warship: nothing has naval strength.
    expect(rules.units.every((u) => u.naval === 0)).toBe(true);
  });

  test("levels: production 20 then 40 + 40L, storage 800 + 700L, pop 50 + 40L", () => {
    expect(rules.levels.production).toEqual([20, 80, 120, 160, 200, 240, 280, 320, 360]);
    expect(rules.levels.storage).toEqual([800, 1500, 2200, 2900, 3600, 4300, 5000, 5700, 6400]);
    expect(rules.levels.population).toEqual([50, 90, 130, 170, 210, 250, 290, 330, 370]);
  });

  test("colonist cost 300 × min(k, 6) of each", () => {
    expect(rules.settlerCost).toHaveLength(7);
    expect(rules.settlerCost[1]).toEqual({ wood: 300, stone: 300, gold: 300 });
    expect(rules.settlerCost[6]).toEqual({ wood: 1800, stone: 1800, gold: 1800 });
  });

  test("roles, start city, time, resource scale", () => {
    expect(rules.roles).toEqual({
      producers: { wood: "sawmill", stone: "pit", gold: "forge" },
      storage: "depot",
      population: "keep",
      buildSpeed: null,
      wall: null,
      settler: "colonist",
    });
    expect(rules.newCity).toEqual({
      buildings: { keep: 1, sawmill: 1, pit: 1, forge: 1, depot: 1 },
      stock: { wood: 200, stone: 200, gold: 200 },
      units: {},
    });
    expect(rules.time).toEqual({ matchEnd: 604800, attackFrom: 21600, minTravel: 4800 });
    expect(rules.resourceScale).toBe(3600);
    expect(rules.neutralProduction).toBe(false);
    expect(rules.travelProbes).toEqual([{ label: "any", group: { kind: "attack", units: {} } }]);
  });

  test("queues: build 4 on completed levels, camp and docks of 4 × 300, batch delivery, 100%/50% refunds", () => {
    expect(rules.queues).toEqual({
      build: { max: 4, requiresOn: "completed" },
      recruit: [
        { id: "camp", building: "camp", maxBatches: 4, maxCount: 300 },
        { id: "docks", building: "docks", maxBatches: 4, maxCount: 300 },
      ],
      delivery: "batch",
      refund: {
        build: { queuedPm: 1000, active: { pm: 500 } },
        recruit: { queuedPm: 1000, active: { pm: 500 } },
      },
    });
  });

  test("movement, diplomacy and tool options", () => {
    expect(rules.movement).toEqual({
      recall: { window: 900, kinds: ["support"], stationed: "whole", dismiss: false },
      shipment: { base: 300, perLevel: 300, building: "docks" },
      transportRule: true,
      spyMinGold: 50,
    });
    expect(rules.diplomacy).toEqual({
      allianceMax: 3,
      maxPacts: 1,
      pactDuration: null,
      maxOpenProposals: 2,
      proposalTtl: 21600,
      messageMaxChars: 500,
      proposalTextMaxChars: 200,
      allianceNameMaxChars: 16,
    });
    expect(rules.toolOptions).toEqual({ foundSlot: true, pactUntil: false });
  });

  test("event classes: six, build and recruit share one, match_end alone", () => {
    expect(rules.eventClasses).toEqual(eventClasses());
    expect(rules.eventClasses).toEqual({
      build_done: 0,
      recruit_done: 0,
      arrive_return: 1,
      arrive_support: 1,
      arrive_shipment: 1,
      arrive_found: 1,
      arrive_spy: 2,
      arrive_attack: 3,
      proposal_expire: 4,
      pact_expire: 4,
      hill_open: 4,
      match_end: 5,
    });
    expect(new Set(Object.values(rules.eventClasses)).size).toBe(6);
  });

  test("gateway caps and wake table", () => {
    expect(rules.gateway).toEqual({
      roundTripsPerWake: 6,
      toolCallsPerRoundTrip: 8,
      toolCallsPerWake: 30,
      ownWakesPerDay: 8,
      socialWakesPerDay: 6,
      groupWindow: 300,
      urgentMinGap: 300,
      selfWake: { min: 1800, max: 21600 },
      safetyWake: 21600,
      attackLaunchesPerDay: 10,
      messagesPerDay: 10,
      notesMaxChars: 2000,
      wake: wakeTable(),
      publicOncePerDay: [],
    });
    expect(rules.gateway.wake).toEqual({
      incoming_attack: { party: "urgent", ally: "social" },
      city_conquered: { target: "urgent" },
      queue_empty: { self: "own" },
      battle_report: { self: "own", target: "social", stationed: "social" },
      spy_report: { self: "own" },
      spy_failed: { self: "own" },
      message: { target: "social" },
      proposal: { target: "social" },
      proposal_answered: { target: "social" },
      spy_detected: { target: "social" },
    });
  });
});

/** Every building, unit and recruit queue id of compiled rules. */
function idsOf(r: CompiledRules): Set<string> {
  return new Set([
    ...r.buildings.map((b) => b.id),
    ...r.units.map((u) => u.id),
    ...r.queues.recruit.map((q) => q.id),
  ]);
}

describe("differs from perfidia-1 on every axis the core could hard-code", () => {
  test("no building, unit or queue id is shared", () => {
    const ours = idsOf(rules);
    const theirs = idsOf(perfidia);
    expect([...ours].filter((id) => theirs.has(id))).toEqual([]);
    const roles = rules.roles;
    const named = [
      ...Object.values(roles.producers),
      roles.storage,
      roles.population,
      roles.settler,
    ];
    expect(named.filter((id) => theirs.has(id))).toEqual([]);
  });

  test("time, classes, gateway, wake table, recall, diplomacy, tool options and refunds", () => {
    expect(rules.time.minTravel).not.toBe(perfidia.time.minTravel);
    expect(rules.time.attackFrom).not.toBe(perfidia.time.attackFrom);
    expect(rules.eventClasses).not.toEqual(perfidia.eventClasses);
    expect(rules.eventClasses["build_done"]).toBe(rules.eventClasses["recruit_done"]);
    expect(perfidia.eventClasses["build_done"]).not.toBe(perfidia.eventClasses["recruit_done"]);
    expect(rules.eventClasses["match_end"]).not.toBe(perfidia.eventClasses["match_end"]);
    const g = rules.gateway;
    const pg = perfidia.gateway;
    for (const key of [
      "toolCallsPerWake",
      "ownWakesPerDay",
      "socialWakesPerDay",
      "urgentMinGap",
      "safetyWake",
      "attackLaunchesPerDay",
      "messagesPerDay",
    ] as const) {
      expect([key, g[key]]).not.toEqual([key, pg[key]]);
    }
    expect(g.selfWake).not.toEqual(pg.selfWake);
    expect(g.wake).not.toEqual(pg.wake);
    expect(g.publicOncePerDay).not.toEqual(pg.publicOncePerDay);
    expect(rules.movement.recall).not.toEqual(perfidia.movement.recall);
    expect(rules.movement.recall.window).not.toBe(perfidia.movement.recall.window);
    expect(rules.movement.spyMinGold).not.toBe(perfidia.movement.spyMinGold);
    expect(rules.diplomacy.allianceMax).not.toBe(perfidia.diplomacy.allianceMax);
    expect(rules.diplomacy.pactDuration).not.toBe(perfidia.diplomacy.pactDuration);
    expect(rules.toolOptions).not.toEqual(perfidia.toolOptions);
    expect(rules.queues.refund).not.toEqual(perfidia.queues.refund);
    expect(rules.queues.delivery).not.toBe(perfidia.queues.delivery);
    expect(rules.queues.build.requiresOn).not.toBe(perfidia.queues.build.requiresOn);
    expect(rules.roles.wall).toBeNull();
    expect(rules.roles.buildSpeed).toBeNull();
  });
});

describe("overrides reach the tables", () => {
  test("economy, units, gateway and diplomacy follow the config", () => {
    const r = sandboxRules(3, {
      "economy.maxLevel": 10,
      "economy.buildTime": 300,
      "economy.militaryKeep": 0,
      "units.spearman.camp": 0,
      "units.colonist.scaleCap": 3,
      "queues.batchMax": 50,
      "diplomacy.pactDuration": 86400,
      "gateway.toolCallsPerWake": null,
    });
    expect(table(r.buildings, "camp").requires).toEqual({});
    expect(table(r.buildings, "keep").time[10]).toEqual([3000]);
    expect(table(r.units, "spearman").requires).toEqual({});
    expect(table(r.units, "spearman").time).toHaveLength(11);
    expect(table(r.units, "axeman").maxPerOrder).toBe(50);
    expect(table(r.units, "colonist").maxPerOrder).toBe(1);
    expect(r.queues.recruit[0]?.maxCount).toBe(50);
    expect(r.settlerCost).toHaveLength(4);
    expect(r.diplomacy.pactDuration).toBe(86400);
    expect(r.gateway.toolCallsPerWake).toBeNull();
    expect(checkRules(r)).toEqual([]);
  });
});
