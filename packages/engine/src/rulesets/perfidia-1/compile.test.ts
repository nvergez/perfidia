import { describe, expect, test } from "bun:test";
import { CompiledRulesSchema, DOMAIN_EVENT_KINDS, type CompiledRules } from "@perfidia/protocol";
import { compileRules } from "./compile.ts";
import { PERFIDIA_1_DEFAULTS, PerfidiaConfigSchema } from "./config.ts";

// `compile` against the tables of perfidia-1 §4.1, §5.2 and §6.3, and the rule data of
// docs/architecture.md §3.3 / §15 T06.

const rules = compileRules(PERFIDIA_1_DEFAULTS, 8);

function building(r: CompiledRules, id: string) {
  const b = r.buildings.find((x) => x.id === id);
  if (b === undefined) throw new Error(`no building ${id}`);
  return b;
}

function unit(r: CompiledRules, id: string) {
  const u = r.units.find((x) => x.id === id);
  if (u === undefined) throw new Error(`no unit ${id}`);
  return u;
}

describe("compileRules", () => {
  test("parses with the CompiledRules schema for every N = 6..12", () => {
    for (let n = 6; n <= 12; n += 1) {
      const r = compileRules(PERFIDIA_1_DEFAULTS, n);
      expect(CompiledRulesSchema.parse(r)).toEqual(r);
      expect(r.players).toBe(n);
      expect(r.ruleset).toBe("perfidia-1@1.0.0");
    }
  });

  test("is pure: two calls give equal, unshared objects", () => {
    const a = compileRules(PERFIDIA_1_DEFAULTS, 6);
    const b = compileRules(PERFIDIA_1_DEFAULTS, 6);
    expect(a).toEqual(b);
    expect(a.gateway.wake).not.toBe(b.gateway.wake);
    expect(a.eventClasses).not.toBe(b.eventClasses);
  });

  test("keeps the canonical orders of §1.1", () => {
    expect(rules.buildings.map((b) => b.id)).toEqual([
      "hall",
      "lumber",
      "quarry",
      "mine",
      "warehouse",
      "barracks",
      "harbor",
      "wall",
    ]);
    expect(rules.units.map((u) => u.id)).toEqual([
      "guard",
      "raider",
      "settler",
      "transport",
      "warship",
    ]);
  });

  test("time and roles", () => {
    expect(rules.time).toEqual({ matchEnd: 604800, attackFrom: 43200, minTravel: 3600 });
    expect(rules.resourceScale).toBe(3600);
    expect(rules.roles).toEqual({
      producers: { wood: "lumber", stone: "quarry", gold: "mine" },
      storage: "warehouse",
      population: "hall",
      buildSpeed: "hall",
      wall: "wall",
      settler: "settler",
    });
  });
});

describe("per-level tables of §4.1", () => {
  test("production, warehouse cap and hall pop cap", () => {
    expect(rules.levels.production).toEqual([50, 75, 110, 155, 210, 275, 350, 435, 530, 635, 750]);
    expect(rules.levels.storage).toEqual([
      660, 1000, 1460, 2040, 2740, 3560, 4500, 5560, 6740, 8040, 9460,
    ]);
    expect(rules.levels.population).toEqual([40, 62, 88, 118, 152, 190, 232, 278, 328, 382, 440]);
  });

  test("build divisor (9 + hall): a level-1 building at H1 takes its base time", () => {
    for (const b of rules.buildings) {
      expect(b.maxLevel).toBe(10);
      expect(b.cost).toHaveLength(11);
      expect(b.time).toHaveLength(11);
      for (const row of b.time) {
        expect(row).toHaveLength(11);
        for (const t of row) expect(t).toBeGreaterThanOrEqual(1);
      }
    }
    expect(building(rules, "hall").time[1]?.[1]).toBe(1800);
    expect(building(rules, "warehouse").time[1]?.[1]).toBe(1200);
  });

  test("recruit factor 10 / (9 + L)", () => {
    const guard = unit(rules, "guard");
    expect(guard.time).toEqual([333, 300, 272, 250, 230, 214, 200, 187, 176, 166, 157]);
  });
});

describe("§5.2 examples", () => {
  test("hall 2 at H1: 144/144/96 and 2880 s", () => {
    const hall = building(rules, "hall");
    expect(hall.cost[2]).toEqual({ wood: 144, stone: 144, gold: 96 });
    expect(hall.time[2]?.[1]).toBe(2880);
  });

  test("lumber 5 at H5: 92/230/138 and 4928 s", () => {
    const lumber = building(rules, "lumber");
    expect(lumber.cost[5]).toEqual({ wood: 92, stone: 230, gold: 138 });
    expect(lumber.time[5]?.[5]).toBe(4928);
  });

  test("harbor 10 at H10: 1360/816/816 and 17178 s", () => {
    const harbor = building(rules, "harbor");
    expect(harbor.cost[10]).toEqual({ wood: 1360, stone: 816, gold: 816 });
    expect(harbor.time[10]?.[10]).toBe(17178);
  });

  test("hall 10 at H9: 1224/1224/816 and 13600 s", () => {
    const hall = building(rules, "hall");
    expect(hall.cost[10]).toEqual({ wood: 1224, stone: 1224, gold: 816 });
    expect(hall.time[10]?.[9]).toBe(13600);
  });

  test("level 1 costs the base; requirements are those of §5.1", () => {
    expect(building(rules, "wall").cost[1]).toEqual({ wood: 30, stone: 120, gold: 30 });
    expect(building(rules, "barracks").requires).toEqual({ hall: 2 });
    expect(building(rules, "harbor").requires).toEqual({ hall: 3 });
    expect(building(rules, "wall").requires).toEqual({ barracks: 1 });
  });

  test("maxing every building of a fresh city costs ≈ 77 k resources (27.8 k / 32.1 k / 17.5 k)", () => {
    const total = { wood: 0, stone: 0, gold: 0 };
    for (const b of rules.buildings) {
      const levels: Readonly<Record<string, number>> = PERFIDIA_1_DEFAULTS.start.capital.buildings;
      const start = levels[b.id] ?? 0;
      for (const c of b.cost.slice(start + 1)) {
        total.wood += c.wood;
        total.stone += c.stone;
        total.gold += c.gold;
      }
    }
    expect(Math.round(total.wood / 100)).toBe(278);
    expect(Math.round(total.stone / 100)).toBe(321);
    expect(Math.round(total.gold / 100)).toBe(175);
  });
});

describe("§6 units", () => {
  test("recruit times of §6.3: guard 300/214/157 s at barracks 1/5/10", () => {
    const guard = unit(rules, "guard");
    expect([guard.time[1], guard.time[5], guard.time[10]]).toEqual([300, 214, 157]);
  });

  test("stats of §6.1", () => {
    expect(unit(rules, "raider")).toMatchObject({
      domain: "land",
      attack: 20,
      defense: 5,
      carry: 50,
      pop: 1,
      cost: { wood: 50, stone: 20, gold: 60 },
      queue: "barracks",
      requires: { barracks: 1 },
      maxPerOrder: 500,
    });
    expect(unit(rules, "transport")).toMatchObject({
      domain: "naval",
      capacity: 20,
      pop: 2,
      queue: "harbor",
    });
    expect(unit(rules, "warship")).toMatchObject({ naval: 50, pop: 4, requires: { harbor: 3 } });
    expect(unit(rules, "settler")).toMatchObject({
      pop: 10,
      maxPerOrder: 1,
      requires: { barracks: 2, hall: 3 },
    });
  });

  test("settler cost base × min(k, 10) for k = 0..10", () => {
    expect(rules.settlerCost).toHaveLength(11);
    expect(rules.settlerCost[1]).toEqual({ wood: 450, stone: 450, gold: 750 });
    expect(rules.settlerCost[2]).toEqual({ wood: 900, stone: 900, gold: 1500 });
    expect(rules.settlerCost[6]).toEqual({ wood: 2700, stone: 2700, gold: 4500 });
    expect(rules.settlerCost[10]).toEqual({ wood: 4500, stone: 4500, gold: 7500 });
  });
});

describe("rule data", () => {
  test("queues: projected requirements, refunds build pro rata and recruit uncompleted at 1000‰", () => {
    expect(rules.queues).toEqual({
      build: { max: 5, requiresOn: "projected" },
      recruit: [
        { id: "barracks", building: "barracks", maxBatches: 5, maxCount: 500 },
        { id: "harbor", building: "harbor", maxBatches: 5, maxCount: 500 },
      ],
      delivery: "trickle",
      refund: {
        build: { queuedPm: 1000, active: "prorata" },
        recruit: { queuedPm: 1000, active: "uncompleted" },
      },
    });
  });

  test("toolOptions both false; new city seed; neutral cities do not produce", () => {
    expect(rules.toolOptions).toEqual({ foundSlot: false, pactUntil: false });
    expect(rules.newCity).toEqual({
      buildings: {
        hall: 1,
        lumber: 1,
        quarry: 1,
        mine: 1,
        warehouse: 1,
        barracks: 0,
        harbor: 0,
        wall: 0,
      },
      stock: { wood: 300, stone: 300, gold: 300 },
      units: {},
    });
    expect(rules.neutralProduction).toBe(false);
  });

  test("movement: recall, shipment cap, transport rule, spy gold", () => {
    expect(rules.movement).toEqual({
      recall: {
        window: 600,
        kinds: ["attack", "support", "found"],
        stationed: "partial",
        dismiss: true,
      },
      shipment: { base: 500, perLevel: 500, building: "harbor" },
      transportRule: true,
      spyMinGold: 100,
    });
  });

  test("allianceMax = max(2, floor(N / 3))", () => {
    expect(
      [6, 7, 8, 9, 10, 11, 12].map(
        (n) => compileRules(PERFIDIA_1_DEFAULTS, n).diplomacy.allianceMax,
      ),
    ).toEqual([2, 2, 2, 3, 3, 3, 4]);
    expect(rules.diplomacy).toEqual({
      allianceMax: 2,
      maxPacts: 2,
      pactDuration: 172800,
      maxOpenProposals: 3,
      proposalTtl: 43200,
      messageMaxChars: 1000,
      proposalTextMaxChars: 300,
      allianceNameMaxChars: 24,
    });
  });

  test("gateway: the two budgets, urgentMinGap, no per-wake call cap, §14.1 caps", () => {
    const { wake: _, publicOncePerDay, ...caps } = rules.gateway;
    expect(caps).toEqual({
      roundTripsPerWake: 8,
      toolCallsPerRoundTrip: 10,
      toolCallsPerWake: null,
      ownWakesPerDay: 12,
      socialWakesPerDay: 8,
      groupWindow: 600,
      urgentMinGap: 600,
      selfWake: { min: 600, max: 43200 },
      safetyWake: 43200,
      attackLaunchesPerDay: 20,
      messagesPerDay: 20,
      notesMaxChars: 4000,
    });
    expect(publicOncePerDay).toEqual(["domination_started"]);
  });

  test("the wake table of docs/architecture.md §8.5", () => {
    expect(rules.gateway.wake).toEqual({
      incoming_attack: { party: "urgent", target: "social", ally: "social", stationed: "social" },
      siege_started: { target: "urgent", ally: "urgent" },
      city_conquered: { target: "urgent" },
      betrayal: { target: "urgent" },
      domination_started: { public: "urgent" },
      queue_empty: { self: "own" },
      battle_report: { self: "own", target: "social", stationed: "social", party: "social" },
      spy_report: { self: "own" },
      spy_failed: { self: "own" },
      message: { target: "social" },
      proposal: { target: "social" },
      proposal_answered: { target: "social" },
      spy_detected: { target: "social" },
    });
  });

  test("event classes of §1.4: every domain kind covered, match_end alone in its class", () => {
    const classes = rules.eventClasses;
    for (const kind of DOMAIN_EVENT_KINDS) expect(classes[kind]).toBeDefined();
    expect(classes).toEqual({
      build_done: 1,
      recruit_done: 2,
      arrive_return: 3,
      arrive_support: 4,
      arrive_shipment: 5,
      arrive_spy: 6,
      arrive_attack: 7,
      arrive_found: 8,
      siege_end: 9,
      proposal_expire: 10,
      pact_expire: 10,
      domination_open: 10,
      domination_end: 11,
      match_end: 12,
    });
    const end = classes["match_end"];
    expect(Object.values(classes).filter((c) => c === end)).toHaveLength(1);
  });

  test("travel probes: transport, warship, spy", () => {
    expect(rules.travelProbes).toEqual([
      { label: "transport", group: { kind: "attack", units: { transport: 1 } } },
      { label: "warship", group: { kind: "attack", units: { warship: 1 } } },
      { label: "spy", group: { kind: "spy", units: {} } },
    ]);
  });
});

describe("overrides reach the tables", () => {
  test("maxLevel, production, offsets and settler cap", () => {
    const config = PerfidiaConfigSchema.parse({
      ...structuredClone(PERFIDIA_1_DEFAULTS),
      economy: {
        ...structuredClone(PERFIDIA_1_DEFAULTS.economy),
        maxLevel: 12,
        production: { a: 0, b: 10, c: 60 },
      },
      settler: { scaleCap: 4, maxPerOrder: 2 },
    });
    const r = compileRules(config, 6);
    expect(r.levels.production).toHaveLength(13);
    expect(r.levels.production[12]).toBe(180);
    expect(r.buildings[0]?.time[12]).toHaveLength(13);
    expect(r.settlerCost).toHaveLength(5);
    expect(r.settlerCost[4]).toEqual({ wood: 1800, stone: 1800, gold: 3000 });
    expect(unit(r, "settler").maxPerOrder).toBe(2);
  });
});
