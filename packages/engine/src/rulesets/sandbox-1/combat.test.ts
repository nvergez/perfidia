import { describe, expect, test } from "bun:test";
import { cas, lossPm } from "@perfidia/engine/core";
import { PlayerIdSchema, type PlayerId, type UnitCounts } from "@perfidia/protocol";
import fc from "fast-check";
import {
  attackStrength,
  carryOf,
  defenseStrength,
  lootTake,
  resolveBattle,
  survivorsOf,
  type DefenderGroup,
} from "./combat.ts";
import { compileRules } from "./compile.ts";
import { SANDBOX_1_DEFAULTS } from "./config.ts";

// Combat and loot of sandbox-1 as pure functions (docs/architecture.md §3.8), with the P13-style
// properties: survivors + losses = initial per stack and per group, more attackers never weaken
// the attack, the loser loses every land unit, boats count in neither strength.

const UNITS = compileRules(SANDBOX_1_DEFAULTS, 4).units;
const p = (n: number): PlayerId => PlayerIdSchema.parse(`p${n}`);

function battle(attacker: UnitCounts, defenders: DefenderGroup[], keep = 1) {
  return resolveBattle(UNITS, { attacker, defenders, keep, keepDefense: 10 });
}

describe("strengths", () => {
  test("A counts attack of land units; D counts defense of land units plus 10·keep; boats count in neither", () => {
    expect(attackStrength(UNITS, { spearman: 2, axeman: 3, colonist: 1, boat: 9 })).toBe(55);
    expect(
      defenseStrength(
        UNITS,
        [
          { owner: p(2), units: { spearman: 2, axeman: 1, boat: 4 } },
          { owner: p(3), units: { spearman: 1, colonist: 2 } },
        ],
        3,
        10,
      ),
    ).toBe(30 + 5 + 15 + 30);
  });
});

describe("examples", () => {
  test("the attacker wins: q = lossPm(D, A) per land stack; every defender and its boats die", () => {
    const r = battle({ axeman: 20, colonist: 1, boat: 2 }, [
      { owner: p(2), units: { spearman: 4, boat: 3 } },
      { owner: p(3), units: { spearman: 2 } },
    ]);
    expect(r.attack).toBe(300);
    expect(r.defense).toBe(100);
    expect(r.winner).toBe("attacker");
    expect(r.lossPm).toBe(lossPm(100, 300));
    expect(r.lossPm).toBe(110);
    expect(r.attackerLost).toEqual({ axeman: cas(20, 110) });
    expect(r.attackerLost).toEqual({ axeman: 2 });
    expect(r.defenderLost).toEqual([{ spearman: 4, boat: 3 }, { spearman: 2 }]);
  });

  test("a tie goes to the defender and wipes out both sides' land units", () => {
    const exact = battle({ axeman: 1, boat: 1 }, [{ owner: p(2), units: { spearman: 1 } }], 0);
    expect(exact.attack).toBe(15);
    expect(exact.defense).toBe(15);
    expect(exact.winner).toBe("defender");
    expect(exact.lossPm).toBe(1000);
    expect(exact.attackerLost).toEqual({ axeman: 1 });
    expect(exact.defenderLost).toEqual([{ spearman: 1 }]);
  });

  test("A = D = 0: the defender wins and every land unit dies (q = 1000, no division by zero)", () => {
    const r = battle({ colonist: 1, boat: 1 }, [{ owner: p(2), units: { colonist: 2 } }], 0);
    expect(r.winner).toBe("defender");
    expect(r.lossPm).toBe(1000);
    expect(r.attackerLost).toEqual({ colonist: 1 });
    expect(r.defenderLost).toEqual([{ colonist: 2 }]);
  });

  test("the defender wins: split stack losses by largest remainder (73 over 60 and 40 → 44 and 29)", () => {
    // D = 100 · 15 + 10 = 1510, A = 86 · 15 = 1290: q = lossPm(1290, 1510) = 729, cas(100, 729) = 73.
    const r = battle({ axeman: 86, boat: 2 }, [
      { owner: p(2), units: { spearman: 60 } },
      { owner: p(2), units: { spearman: 40, boat: 1 } },
      { owner: p(3), units: { spearman: 10 } },
    ]);
    expect(r.attack).toBe(1290);
    expect(r.defense).toBe(1660);
    expect(r.winner).toBe("defender");
    // Recomputed with the third group: p2's stack of 100 and p3's stack of 10 lose cas(n, q) each.
    const q = lossPm(1290, 1660);
    expect(r.lossPm).toBe(q);
    const l2 = cas(100, q);
    expect((r.defenderLost[0]?.["spearman"] ?? 0) + (r.defenderLost[1]?.["spearman"] ?? 0)).toBe(
      l2,
    );
    expect(r.defenderLost[2]).toEqual({ spearman: cas(10, q) });
    expect(r.attackerLost).toEqual({ axeman: 86 });
    expect(r.defenderLost[1]?.["boat"]).toBeUndefined();

    const exact = battle({ axeman: 86 }, [
      { owner: p(2), units: { spearman: 60 } },
      { owner: p(2), units: { spearman: 40 } },
    ]);
    expect(exact.defense).toBe(1510);
    expect(exact.lossPm).toBe(729);
    expect(exact.defenderLost).toEqual([{ spearman: 44 }, { spearman: 29 }]);
  });
});

describe("loot", () => {
  test("half of each resource is lootable; T ≤ carry takes everything", () => {
    expect(lootTake({ wood: 101, stone: 0, gold: 7 }, 60, 500)).toEqual({
      wood: 50,
      stone: 0,
      gold: 3,
    });
    expect(lootTake({ wood: 101, stone: 0, gold: 7 }, 53, 500)).toEqual({
      wood: 50,
      stone: 0,
      gold: 3,
    });
  });

  test("T > carry: take_r = floor(lootable_r × carry / T), the leftover capacity unused", () => {
    expect(lootTake({ wood: 101, stone: 0, gold: 7 }, 10, 500)).toEqual({
      wood: 9,
      stone: 0,
      gold: 0,
    });
    expect(lootTake({ wood: 1000, stone: 400, gold: 101 }, 250, 500)).toEqual({
      wood: 166,
      stone: 66,
      gold: 16,
    });
    expect(lootTake({ wood: 1000, stone: 400, gold: 101 }, 0, 500)).toEqual({
      wood: 0,
      stone: 0,
      gold: 0,
    });
  });

  test("lootPm follows the config", () => {
    expect(lootTake({ wood: 100, stone: 100, gold: 100 }, 1000, 1000)).toEqual({
      wood: 100,
      stone: 100,
      gold: 100,
    });
    expect(lootTake({ wood: 9, stone: 9, gold: 9 }, 1000, 0)).toEqual({
      wood: 0,
      stone: 0,
      gold: 0,
    });
  });

  test("never more than lootable or carry (property)", () => {
    fc.assert(
      fc.property(
        fc.record({ wood: fc.nat(100000), stone: fc.nat(100000), gold: fc.nat(100000) }),
        fc.nat(200000),
        fc.integer({ min: 0, max: 1000 }),
        (stock, carry, pm) => {
          const take = lootTake(stock, carry, pm);
          const taken = take.wood + take.stone + take.gold;
          for (const r of ["wood", "stone", "gold"] as const) {
            expect(take[r]).toBeGreaterThanOrEqual(0);
            expect(take[r]).toBeLessThanOrEqual(Math.floor((stock[r] * pm) / 1000));
          }
          const lootable =
            Math.floor((stock.wood * pm) / 1000) +
            Math.floor((stock.stone * pm) / 1000) +
            Math.floor((stock.gold * pm) / 1000);
          expect(taken).toBeLessThanOrEqual(Math.max(carry, 0));
          if (lootable <= carry) expect(taken).toBe(lootable);
        },
      ),
    );
  });

  test("carry counts land survivors only", () => {
    expect(carryOf(UNITS, { spearman: 2, axeman: 3, colonist: 1, boat: 5 })).toBe(20 + 75);
  });
});

const counts = fc
  .record(
    {
      spearman: fc.integer({ min: 0, max: 200 }),
      axeman: fc.integer({ min: 0, max: 200 }),
      colonist: fc.integer({ min: 0, max: 3 }),
      boat: fc.integer({ min: 0, max: 20 }),
    },
    { requiredKeys: [] },
  )
  .map((r): UnitCounts => {
    const out: UnitCounts = {};
    for (const [id, n] of Object.entries(r)) if (n > 0) out[id] = n;
    return out;
  });
const groups = fc.array(fc.record({ owner: fc.integer({ min: 2, max: 4 }), units: counts }), {
  maxLength: 5,
});

function total(list: readonly UnitCounts[], id: string): number {
  return list.reduce((s, u) => s + (u[id] ?? 0), 0);
}

describe("properties (P13 for sandbox-1)", () => {
  test("conservation per group and per stack; outcomes follow A > D; boats", () => {
    fc.assert(
      fc.property(counts, groups, fc.integer({ min: 0, max: 8 }), (attacker, raw, keep) => {
        const defenders = raw.map((g) => ({ owner: p(g.owner), units: g.units }));
        const r = resolveBattle(UNITS, { attacker, defenders, keep, keepDefense: 10 });
        expect(r.winner === "attacker").toBe(r.attack > r.defense);
        const left = survivorsOf(UNITS, attacker, r.attackerLost);
        for (const u of UNITS) {
          const n = attacker[u.id] ?? 0;
          expect((left[u.id] ?? 0) + (r.attackerLost[u.id] ?? 0)).toBe(n);
          if (u.domain === "naval") expect(r.attackerLost[u.id]).toBeUndefined();
          else if (r.winner === "defender") expect(r.attackerLost[u.id] ?? 0).toBe(n);
          else expect(r.attackerLost[u.id] ?? 0).toBe(cas(n, r.lossPm));
        }
        expect(r.defenderLost).toHaveLength(defenders.length);
        for (const [i, g] of defenders.entries()) {
          const lost = r.defenderLost[i] ?? {};
          for (const u of UNITS) {
            const n = g.units[u.id] ?? 0;
            const l = lost[u.id] ?? 0;
            expect(l).toBeGreaterThanOrEqual(0);
            expect(l).toBeLessThanOrEqual(n);
            if (r.winner === "attacker") expect(l).toBe(n);
            else if (u.domain === "naval") expect(l).toBe(0);
          }
        }
        if (r.winner === "defender") {
          for (const owner of new Set(defenders.map((g) => g.owner))) {
            const mine = defenders.flatMap((g, i) => (g.owner === owner ? [i] : []));
            for (const u of UNITS) {
              if (u.domain !== "land") continue;
              const n = total(
                mine.map((i) => defenders[i]?.units ?? {}),
                u.id,
              );
              const l = total(
                mine.map((i) => r.defenderLost[i] ?? {}),
                u.id,
              );
              expect(l).toBe(cas(n, r.lossPm));
            }
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  test("adding attackers never lowers A; boats never change A or D", () => {
    fc.assert(
      fc.property(counts, counts, (a, extra) => {
        const more: UnitCounts = {};
        for (const u of UNITS) {
          const n = (a[u.id] ?? 0) + (extra[u.id] ?? 0);
          if (n > 0) more[u.id] = n;
        }
        expect(attackStrength(UNITS, more)).toBeGreaterThanOrEqual(attackStrength(UNITS, a));
        const withBoats = { ...a, boat: (a["boat"] ?? 0) + 7 };
        expect(attackStrength(UNITS, withBoats)).toBe(attackStrength(UNITS, a));
        expect(defenseStrength(UNITS, [{ owner: p(2), units: withBoats }], 1, 10)).toBe(
          defenseStrength(UNITS, [{ owner: p(2), units: a }], 1, 10),
        );
      }),
    );
  });

  test("pure: inputs untouched", () => {
    const attacker = { axeman: 5, boat: 1 };
    const defenders = [{ owner: p(2), units: { spearman: 1 } }];
    const copy = JSON.stringify({ attacker, defenders });
    resolveBattle(UNITS, { attacker, defenders, keep: 1, keepDefense: 10 });
    expect(JSON.stringify({ attacker, defenders })).toBe(copy);
  });
});
