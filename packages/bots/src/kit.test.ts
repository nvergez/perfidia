// The kit and the build planner read structured rules only (docs/architecture.md §11.1): roles from
// unit stats, requirements per `requiresOn`, affordability, travel probes.

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { RulesInfoSchema } from "@perfidia/protocol";
import { perfidiaRules, res, rulesInfo, sandboxRules } from "./fixtures.test.ts";
import {
  etaAfford,
  fmtTime,
  makeKit,
  meets,
  pickTravel,
  rulesKey,
  storageLevelFor,
  timesAffordable,
  unitsInReport,
} from "./kit.ts";
import { planBuilds, unlockWishes } from "./plan.ts";

const pKit = makeKit(RulesInfoSchema.parse(rulesInfo(perfidiaRules(6))));
const sKit = makeKit(RulesInfoSchema.parse(rulesInfo(sandboxRules(6))));
const ZERO = res(0, 0, 0);

describe("roles from unit stats", () => {
  test("perfidia shape: wall, warships, settler", () => {
    expect(pKit.roles).toEqual({
      defender: "guard",
      attacker: "raider",
      founder: "settler",
      carrier: "transport",
      navy: "warship",
    });
    expect(pKit.wall).toBe("wall");
    expect(pKit.producers).toEqual({ wood: "lumber", stone: "quarry", gold: "mine" });
  });

  test("sandbox shape: no wall, no warship", () => {
    expect(sKit.roles).toEqual({
      defender: "spearman",
      attacker: "axeman",
      founder: "colonist",
      carrier: "boat",
      navy: null,
    });
    expect(sKit.wall).toBeNull();
  });

  test("the cache key is the config hash prefix and the player count", () => {
    const info = RulesInfoSchema.parse(rulesInfo(perfidiaRules(8), "x"));
    expect(rulesKey(info)).toBe(`${info.configHash.slice(0, 16)}:8`);
    expect(rulesKey(info)).not.toBe(pKit.key);
  });

  test("caps come from rules.gateway, not from the interface text", () => {
    expect(pKit.gateway.notesMaxChars).toBe(4000);
    expect(sKit.gateway.toolCallsPerWake).toBe(30);
  });
});

describe("affordability", () => {
  test("etaAfford: now, later with ceilDiv, or never", () => {
    expect(etaAfford(res(500, 500, 500), res(10, 10, 10), res(100, 100, 100), 1000)).toBe(0);
    // 290 gold missing at +310/h: ceilDiv(290 · 3600, 310) = 3368 s (architecture §7.3).
    expect(etaAfford(res(0, 0, 1210), res(0, 0, 310), res(0, 0, 1500), 2040)).toBe(3368);
    expect(etaAfford(res(0, 0, 0), res(0, 0, 0), res(0, 0, 1), 1000)).toBeNull();
    expect(etaAfford(res(0, 0, 0), res(9, 9, 9), res(0, 0, 1001), 1000)).toBeNull();
  });

  test("timesAffordable and storage levels", () => {
    expect(timesAffordable(res(100, 100, 100), res(30, 60, 30))).toBe(1);
    expect(timesAffordable(res(100, 100, 100), ZERO)).toBeGreaterThan(1000);
    // perfidia-1 §6.2: k = 6 costs 4500 gold, which needs warehouse 6.
    expect(storageLevelFor(pKit, 4500)).toBe(6);
    expect(storageLevelFor(pKit, 7500)).toBe(9);
    expect(storageLevelFor(pKit, 99999)).toBeNull();
  });

  test("meets reads missing levels as 0", () => {
    expect(meets({ hall: 2 }, { hall: 2 })).toBe(true);
    expect(meets({ hall: 2 }, {})).toBe(false);
    expect(meets({}, {})).toBe(true);
  });
});

describe("reports and travel", () => {
  test("unitsInReport adds every unit-count object of the report", () => {
    const data = {
      city: "c2",
      units: { home: { guard: 5, raider: 2 }, stationed: [{ owner: "p3", units: { guard: 3 } }] },
      levels: { wall: 2, hall: 3 },
      note: { guard: "many" },
    };
    expect(unitsInReport(pKit, data)).toEqual({ guard: 8, raider: 2 });
    expect(unitsInReport(sKit, data)).toEqual({});
  });

  test("pickTravel: the spy probe for spies, the slowest group probe otherwise", () => {
    expect(pickTravel(pKit, [5400, 4050, 2700], true)).toBe(2700);
    expect(pickTravel(pKit, [5400, 4050, 2700], false)).toBe(5400);
    expect(pickTravel(sKit, [7200], true)).toBe(7200);
    expect(pickTravel(sKit, [], false)).toBeNull();
  });

  test("fmtTime prints game times as the gateway does", () => {
    expect(fmtTime(0)).toBe("D1 00:00");
    expect(fmtTime(604800)).toBe("D8 00:00");
    expect(fmtTime(223370)).toBe("D3 14:02:50");
  });
});

describe("planBuilds", () => {
  const plenty = res(100000, 100000, 100000);
  const start = { hall: 1, lumber: 1, quarry: 1, mine: 1, warehouse: 1 };

  test("projected requirements queue the chain in one call (perfidia shape)", () => {
    const plan = planBuilds(
      pKit,
      start,
      [],
      unlockWishes(pKit, "settler"),
      plenty,
      ZERO,
      100000,
      5,
      7200,
    );
    // settler: barracks 2 and hall 3; barracks needs hall 2.
    expect(plan.items).toEqual(["hall", "barracks", "barracks", "hall"]);
    expect(plan.saving).toBeNull();
    expect(plan.spent).toEqual(res(144 + 60 + 96 + 216, 144 + 80 + 128 + 216, 96 + 50 + 80 + 144));
  });

  test("completed requirements queue the requirement and let the wish wait (sandbox shape)", () => {
    const sStart = { keep: 1, sawmill: 1, pit: 1, forge: 1, depot: 1 };
    const plan = planBuilds(
      sKit,
      sStart,
      [],
      unlockWishes(sKit, "colonist"),
      plenty,
      ZERO,
      100000,
      4,
      7200,
    );
    expect(plan.items).toEqual(["keep"]);
    const later = planBuilds(
      sKit,
      { ...sStart, keep: 2 },
      [],
      unlockWishes(sKit, "colonist"),
      plenty,
      ZERO,
      100000,
      4,
      7200,
    );
    expect(later.items).toEqual(["camp", "camp"]);
  });

  test("queued items count towards projected levels and the queue room", () => {
    const plan = planBuilds(
      pKit,
      start,
      ["hall", "hall"],
      [{ building: "hall", level: 4 }],
      plenty,
      ZERO,
      100000,
      1,
      7200,
    );
    expect(plan.items).toEqual(["hall"]);
    const full = planBuilds(
      pKit,
      start,
      [],
      [{ building: "lumber", level: 10 }],
      plenty,
      ZERO,
      100000,
      2,
      7200,
    );
    expect(full.items).toEqual(["lumber", "lumber"]);
  });

  test("an unaffordable wish within the horizon is saved for; a far one is skipped", () => {
    const wishes = [
      { building: "hall", level: 2 },
      { building: "lumber", level: 2 },
    ];
    // hall 2 costs 144/144/96; from 100 of each, 44 are missing: 2640 s at +60/h, 15840 s at +10/h.
    const soon = planBuilds(
      pKit,
      start,
      [],
      wishes,
      res(100, 100, 100),
      res(60, 60, 60),
      1000,
      5,
      3600,
    );
    expect(soon.items).toEqual([]);
    expect(soon.saving).toEqual(res(144, 144, 96));
    const far = planBuilds(
      pKit,
      start,
      [],
      wishes,
      res(100, 100, 100),
      res(10, 10, 10),
      1000,
      5,
      9000,
    );
    // lumber 2 costs 32/80/48.
    expect(far.items).toEqual(["lumber"]);
    expect(far.saving).toBeNull();
  });

  test("never exceeds the room, the budget or the max level", () => {
    const kits = [pKit, sKit];
    fc.assert(
      fc.property(
        fc.constantFrom(0, 1),
        fc.integer({ min: 0, max: 5 }),
        fc.integer({ min: 0, max: 3000 }),
        fc.array(
          fc.record({ b: fc.integer({ min: 0, max: 7 }), level: fc.integer({ min: 1, max: 12 }) }),
          {
            maxLength: 8,
          },
        ),
        (k, room, stock, raw) => {
          const kit = kits[k]!;
          const ids = kit.rules.buildings.map((b) => b.id);
          const wishes = raw.map((x) => ({ building: ids[x.b % ids.length]!, level: x.level }));
          const levels = Object.fromEntries(ids.map((id) => [id, 1]));
          const budget = res(stock, stock, stock);
          const plan = planBuilds(
            kit,
            levels,
            [],
            wishes,
            budget,
            res(50, 50, 50),
            5000,
            room,
            7200,
          );
          expect(plan.items.length).toBeLessThanOrEqual(room);
          expect(plan.spent.wood).toBeLessThanOrEqual(stock);
          expect(plan.spent.stone).toBeLessThanOrEqual(stock);
          expect(plan.spent.gold).toBeLessThanOrEqual(stock);
          const after: Record<string, number> = { ...levels };
          for (const b of plan.items) after[b] = (after[b] ?? 0) + 1;
          for (const row of kit.rules.buildings)
            expect(after[row.id] ?? 0).toBeLessThanOrEqual(row.maxLevel);
        },
      ),
    );
  });
});
