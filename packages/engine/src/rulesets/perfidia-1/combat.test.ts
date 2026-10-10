import { describe, expect, test } from "bun:test";
import { cas, lossPm } from "@perfidia/engine/core";
import fc from "fast-check";
import {
  type BattleInput,
  type BattleResult,
  battleCredit,
  canBesiege,
  carryOf,
  type CombatStack,
  landAttack,
  landDefense,
  lootOf,
  moralePm,
  NEUTRAL,
  resolveBattle,
  splitLosses,
  type StackOutcome,
  statsOf,
  survivorsOf,
  wallAfterBreach,
} from "./combat.ts";
import { PERFIDIA_1_DEFAULTS } from "./config.ts";

// Combat maths of perfidia-1 §8 and §9: the worked examples of §8.12 and §9.8 (split stack and
// homecoming included), the §15.2 defense targets, the §8.3 table, and property P13.

const d = PERFIDIA_1_DEFAULTS;
const stats = statsOf(d);

const stack = (owner: string, unit: string, ...groups: number[]): CombatStack => ({
  owner,
  unit,
  groups,
});

function outcomeOf(stacks: readonly StackOutcome[], owner: string, unit: string): StackOutcome {
  const s = stacks.find((x) => x.owner === owner && x.unit === unit);
  if (s === undefined) throw new Error(`no stack ${owner}/${unit}`);
  return s;
}

const lost = (r: BattleResult, side: "attacker" | "defender", owner: string, unit: string) =>
  outcomeOf(r[side], owner, unit).lost;
const survived = (r: BattleResult, side: "attacker" | "defender", owner: string, unit: string) =>
  outcomeOf(r[side], owner, unit).survived;

function battle(
  partial: Partial<BattleInput> & Pick<BattleInput, "attacker" | "defender">,
): BattleResult {
  return resolveBattle(d, {
    kind: "city",
    moralePm: 1000,
    acrossWater: false,
    hall: 1,
    wall: 0,
    ...partial,
  });
}

describe("§8.2 morale", () => {
  test("clamp(1000 − 100 × (attacker − foe cities), 700, 1000); 1000 against the Crown", () => {
    expect(moralePm(d, 6, 4)).toBe(800);
    expect(moralePm(d, 3, 6)).toBe(1000);
    expect(moralePm(d, 4, 6)).toBe(1000);
    expect(moralePm(d, 5, 5)).toBe(1000);
    expect(moralePm(d, 12, 1)).toBe(700);
    expect(moralePm(d, 9, 6)).toBe(700);
    expect(moralePm(d, 12, null)).toBe(1000);
  });
});

describe("§8.3 losses", () => {
  test("the winner-loses table: 2:1 25.0%, 3:2 44.3%, 3:1 11.0%, 4:3 56.2%, 1.41:1 50.2%", () => {
    expect(lossPm(1, 2)).toBe(250);
    expect(lossPm(2, 3)).toBe(443);
    expect(lossPm(1, 3)).toBe(110);
    expect(lossPm(3, 4)).toBe(562);
    expect(lossPm(100, 141)).toBe(502);
  });

  test("split stacks: 73 losses over groups of 60 and 40 give 44 and 29", () => {
    expect(splitLosses([60, 40], 73)).toEqual([44, 29]);
  });

  test("ties go to the earlier group; the split always sums to the loss (property)", () => {
    expect(splitLosses([50, 50], 1)).toEqual([1, 0]);
    expect(splitLosses([1, 1, 1], 2)).toEqual([1, 1, 0]);
    expect(splitLosses([], 0)).toEqual([]);
    expect(splitLosses([0, 0], 0)).toEqual([0, 0]);
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 5000 }), { minLength: 1, maxLength: 6 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (sizes, frac) => {
          const n = sizes.reduce((a, b) => a + b, 0);
          const loss = Math.floor(n * frac);
          const split = splitLosses(sizes, loss);
          expect(split.reduce((a, b) => a + b, 0)).toBe(loss);
          for (const [i, l] of split.entries()) {
            expect(l).toBeGreaterThanOrEqual(0);
            expect(l).toBeLessThanOrEqual(sizes[i]!);
            expect(Math.abs(l - (loss * sizes[i]!) / (n || 1))).toBeLessThan(1);
          }
        },
      ),
    );
  });

  test("rejects a loss above the stack", () => {
    expect(() => splitLosses([3, 4], 8)).toThrow(RangeError);
  });
});

describe("§8.12 worked example 1: naval phase, morale, a failed conquest, loot", () => {
  const input: BattleInput = {
    kind: "city",
    moralePm: moralePm(d, 6, 4),
    acrossWater: true,
    attacker: [
      stack("p2", "raider", 360),
      stack("p2", "settler", 1),
      stack("p2", "transport", 19),
      stack("p2", "warship", 8),
    ],
    defender: [
      stack("p5", "guard", 120),
      stack("p5", "raider", 30),
      stack("p5", "transport", 2),
      stack("p5", "warship", 4),
      stack("p7", "guard", 60),
      stack("p7", "warship", 1),
    ],
    hall: 6,
    wall: 4,
  };
  const r = resolveBattle(d, input);

  test("morale 800 and the naval phase", () => {
    expect(r.moralePm).toBe(800);
    expect(r.naval).toEqual({ Na: 320, Nd: 250, winner: "attacker", q: 609 });
    expect(lost(r, "attacker", "p2", "warship")).toEqual([5]);
    expect(survived(r, "attacker", "p2", "transport")).toEqual([19]);
    for (const [owner, unit] of [
      ["p5", "warship"],
      ["p5", "transport"],
      ["p7", "warship"],
    ] as const) {
      expect(survived(r, "defender", owner, unit)).toEqual([0]);
    }
  });

  test("the land phase", () => {
    expect(r.land).toEqual({
      A: 5760,
      D: 4704,
      sumDefense: 3750,
      baseDefense: 170,
      wallPm: 1200,
      winner: "attacker",
      q: 665,
    });
    expect(lost(r, "attacker", "p2", "raider")).toEqual([239]);
    expect(survived(r, "attacker", "p2", "raider")).toEqual([121]);
    expect(lost(r, "attacker", "p2", "settler")).toEqual([1]);
    const defendersLeft = r.defender.reduce((s, x) => s + x.survived[0]!, 0);
    expect(defendersLeft).toBe(0);
    expect(r.winner).toBe("attacker");
    expect(r.attackerWonLand).toBe(true);
  });

  test("wall 4 → 3; the settler died, so it is a raid with loot 2700 / 2000 / 1300", () => {
    expect(wallAfterBreach(d, 4)).toBe(3);
    expect(survivorsOf(r.attacker)).toEqual({ raider: 121, transport: 19, warship: 3 });
    const carry = carryOf(stats, survivorsOf(r.attacker));
    expect(carry).toBe(6050);
    expect(lootOf(d, { wood: 3200, stone: 2500, gold: 1800 }, 5, carry)).toEqual({
      wood: 2700,
      stone: 2000,
      gold: 1300,
    });
  });

  test("battle points: p2 +234; p5 +195, p7 +73", () => {
    const credit = battleCredit(stats, r, "p5");
    expect(credit.attackerByOwner).toEqual([
      { owner: "p5", pop: 170 },
      { owner: "p7", pop: 64 },
    ]);
    expect(credit.attackerByOwner.reduce((s, e) => s + e.pop, 0)).toBe(234);
    expect(credit.defenders).toEqual([
      { owner: "p5", points: 195 },
      { owner: "p7", points: 73 },
    ]);
  });
});

describe("§9.8 worked example 2: train, siege, reinforcement, relief", () => {
  test("the wave wins at no naval cost and starts a siege", () => {
    const r = resolveBattle(d, {
      kind: "city",
      moralePm: moralePm(d, 6, 4),
      acrossWater: true,
      attacker: [
        stack("p2", "raider", 150),
        stack("p2", "settler", 2),
        stack("p2", "transport", 9),
        stack("p2", "warship", 3),
      ],
      defender: [stack("p5", "guard", 40)],
      hall: 6,
      wall: 3,
    });
    expect(r.naval).toEqual({ Na: 120, Nd: 0, winner: "attacker", q: 0 });
    expect(lost(r, "attacker", "p2", "warship")).toEqual([0]);
    expect(r.land).toMatchObject({ A: 2400, D: 1115, winner: "attacker", q: 215 });
    expect(lost(r, "attacker", "p2", "raider")).toEqual([32]);
    expect(lost(r, "attacker", "p2", "settler")).toEqual([0]);
    expect(lost(r, "defender", "p5", "guard")).toEqual([40]);
    expect(wallAfterBreach(d, 3)).toBe(2);
    expect(canBesiege(d, false, 300000)).toBe(true);
    expect(survivorsOf(r.attacker)).toEqual({ raider: 118, settler: 2, transport: 9, warship: 3 });
  });

  test("garrison D = 836, then 3036 with the 100 supporting guards", () => {
    expect(landDefense(d, 118 * 5, 6, 2)).toBe(836);
    expect(landDefense(d, 118 * 5 + 100 * 20, 6, 2)).toBe(3036);
  });

  const garrison = [
    stack("p2", "raider", 118),
    stack("p2", "settler", 2),
    stack("p2", "transport", 9),
    stack("p2", "warship", 3),
    stack("p2", "guard", 60, 40),
  ];

  const relief = (raiders: number) =>
    resolveBattle(d, {
      kind: "relief",
      moralePm: moralePm(d, 3, 6),
      acrossWater: true,
      attacker: [
        stack("p7", "warship", 4),
        stack("p7", "raider", raiders),
        stack("p7", "transport", 8),
      ],
      defender: garrison,
      hall: 6,
      wall: 2,
    });

  test("relief by p7 with 130 raiders loses but kills 86 raiders, 73 guards and 1 settler", () => {
    const r = relief(130);
    expect(r.moralePm).toBe(1000);
    expect(r.naval).toEqual({ Na: 200, Nd: 150, winner: "attacker", q: 562 });
    expect(lost(r, "attacker", "p7", "warship")).toEqual([2]);
    expect(survived(r, "defender", "p2", "warship")).toEqual([0]);
    expect(survived(r, "defender", "p2", "transport")).toEqual([0]);
    expect(r.land).toMatchObject({ A: 2600, D: 3036, winner: "defender", q: 732 });
    expect(survived(r, "attacker", "p7", "raider")).toEqual([0]);
    expect(survived(r, "attacker", "p7", "warship")).toEqual([2]);
    expect(survived(r, "attacker", "p7", "transport")).toEqual([8]);
    expect(lost(r, "defender", "p2", "raider")).toEqual([86]);
    expect(lost(r, "defender", "p2", "settler")).toEqual([1]);
    expect(r.winner).toBe("defender");
    expect(r.attackerWonLand).toBe(false);
  });

  test("the split stack: c11 loses 44 (16 left), c12 loses 29 (11 left)", () => {
    const r = relief(130);
    expect(lost(r, "defender", "p2", "guard")).toEqual([44, 29]);
    expect(survived(r, "defender", "p2", "guard")).toEqual([16, 11]);
    expect(survivorsOf(r.defender)).toEqual({ raider: 32, settler: 1, guard: 27 });
  });

  test("alternative: 160 raiders win with q = 898, 144 lost and 16 go home; the garrison dies", () => {
    const r = relief(160);
    expect(r.land).toMatchObject({ A: 3200, D: 3036, winner: "attacker", q: 898 });
    expect(lost(r, "attacker", "p7", "raider")).toEqual([144]);
    expect(survivorsOf(r.defender)).toEqual({});
  });

  test("alternative: the homecoming of 60 raiders wins with q = 635, 38 lost and 22 home", () => {
    const r = resolveBattle(d, {
      kind: "homecoming",
      moralePm: moralePm(d, 4, 6),
      acrossWater: true,
      attacker: [stack("p5", "raider", 60)],
      defender: [
        stack("p2", "raider", 32),
        stack("p2", "settler", 1),
        stack("p2", "guard", 16, 11),
      ],
      hall: 6,
      wall: 2,
    });
    expect(r.moralePm).toBe(1000);
    expect(r.naval).toBeNull();
    expect(r.land).toMatchObject({ A: 1200, D: 957, winner: "attacker", q: 635 });
    expect(lost(r, "attacker", "p5", "raider")).toEqual([38]);
    expect(survived(r, "attacker", "p5", "raider")).toEqual([22]);
    expect(survivorsOf(r.defender)).toEqual({});
  });
});

describe("§9.3 homecoming without land units", () => {
  test("ships or cargo alone count as A = 0 and lose the whole group", () => {
    const r = resolveBattle(d, {
      kind: "homecoming",
      moralePm: 1000,
      acrossWater: false,
      attacker: [stack("p5", "transport", 3), stack("p5", "warship", 1)],
      defender: [stack("p2", "settler", 1)],
      hall: 1,
      wall: 0,
    });
    expect(r.land).toMatchObject({ A: 0, D: 70, winner: "defender", q: 0 });
    expect(survivorsOf(r.attacker)).toEqual({});
    expect(survivorsOf(r.defender)).toEqual({ settler: 1 });
  });

  test("a city battle lost on land keeps the attacking ships", () => {
    const r = battle({
      attacker: [stack("p1", "raider", 2), stack("p1", "transport", 1)],
      defender: [stack("p2", "guard", 10)],
    });
    expect(r.winner).toBe("defender");
    expect(survivorsOf(r.attacker)).toEqual({ transport: 1 });
  });

  test("a lost naval phase destroys the whole movement and skips the land phase", () => {
    const r = battle({
      acrossWater: true,
      attacker: [
        stack("p1", "raider", 100),
        stack("p1", "transport", 5),
        stack("p1", "warship", 1),
      ],
      defender: [stack("p2", "warship", 2), stack("p2", "guard", 1)],
    });
    expect(r.naval).toEqual({ Na: 50, Nd: 100, winner: "defender", q: 250 });
    expect(r.land).toBeNull();
    expect(survivorsOf(r.attacker)).toEqual({});
    expect(lost(r, "defender", "p2", "warship")).toEqual([1]);
  });

  test("a warship-only strike has no land phase: a harbour strike", () => {
    const r = battle({
      acrossWater: true,
      attacker: [stack("p1", "warship", 3)],
      defender: [stack("p2", "warship", 1), stack("p2", "transport", 2), stack("p2", "guard", 10)],
    });
    expect(r.naval?.winner).toBe("attacker");
    expect(r.land).toBeNull();
    expect(r.winner).toBe("attacker");
    expect(r.attackerWonLand).toBe(false);
    expect(survivorsOf(r.defender)).toEqual({ guard: 10 });
  });

  test("an exact tie goes to the defender and wipes both sides in that phase", () => {
    const exact = battle({
      attacker: [stack("p1", "guard", 54)],
      defender: [stack("p2", "guard", 10)],
    });
    expect(exact.land).toMatchObject({ A: 270, D: 270, winner: "defender", q: 1000 });
    expect(survivorsOf(exact.attacker)).toEqual({});
    expect(survivorsOf(exact.defender)).toEqual({});
  });
});

describe("§8.6 and §9.5: sieges on capitals", () => {
  test("a capital cannot be besieged before t = 172800", () => {
    expect(canBesiege(d, true, 172799)).toBe(false);
    expect(canBesiege(d, true, 172800)).toBe(true);
    expect(canBesiege(d, false, 0)).toBe(true);
  });

  test("a lone settler survives only if q < 500; two settlers keep one while q < 750", () => {
    expect(cas(1, 499)).toBe(0);
    expect(cas(1, 500)).toBe(1);
    expect(cas(2, 749)).toBe(1);
    expect(cas(2, 750)).toBe(2);
  });
});

describe("§15.2 defense targets", () => {
  test("D values", () => {
    expect(landDefense(d, 0, 1, 0)).toBe(70);
    expect(landDefense(d, 10 * 20, 1, 0)).toBe(270);
    expect(landDefense(d, 10 * 20, 3, 0)).toBe(310);
    expect(landDefense(d, 20 * 20, 3, 0)).toBe(510);
    expect(landDefense(d, 76 * 20 + 71 * 5, 7, 2)).toBe(2271);
    expect(landDefense(d, 5 * 20 + 5 * 5, 7, 2)).toBe(346);
    expect(landDefense(d, 200 * 20 + 200 * 5, 10, 10)).toBe(7875);
    expect(landDefense(d, 84 * 20 + 84 * 5, 10, 10)).toBe(3525);
    expect(landDefense(d, 440 * 20, 10, 10)).toBe(13575);
    expect(landDefense(d, 400 * 20, 5, 5)).toBe(10187);
  });

  test("fresh colony: 4 raiders break it; 20 raiders + 1 settler start a siege at q = 30", () => {
    expect(battle({ attacker: [stack("p1", "raider", 4)], defender: [] }).winner).toBe("attacker");
    expect(battle({ attacker: [stack("p1", "raider", 3)], defender: [] }).winner).toBe("defender");
    const r = battle({
      attacker: [stack("p1", "raider", 20), stack("p1", "settler", 1)],
      defender: [],
    });
    expect(r.land?.q).toBe(30);
    expect(survived(r, "attacker", "p1", "settler")).toEqual([1]);
  });

  test("fresh colony with a 10-guard escort: 20 raiders win and lose 9", () => {
    const r = battle({
      attacker: [stack("p1", "raider", 20)],
      defender: [stack("p2", "guard", 10)],
    });
    expect(r.land).toMatchObject({ D: 270, winner: "attacker" });
    expect(lost(r, "attacker", "p1", "raider")).toEqual([9]);
  });

  test("capital at 12:00: a 20-raider rush wins but keeps 8 raiders (400 carry)", () => {
    const r = battle({
      attacker: [stack("p1", "raider", 20)],
      defender: [stack("p2", "guard", 10)],
      hall: 3,
    });
    expect(r.land).toMatchObject({ D: 310, winner: "attacker" });
    expect(survived(r, "attacker", "p1", "raider")).toEqual([8]);
    expect(carryOf(stats, survivorsOf(r.attacker))).toBe(400);
  });

  test("day-4 capital: a 3-city train of 70-raider waves; wave 3 wins with q = 61", () => {
    let defenders = [stack("p2", "guard", 76), stack("p2", "raider", 71)];
    for (const wave of [1, 2]) {
      const r = battle({
        attacker: [stack("p1", "raider", 70)],
        defender: defenders,
        hall: 7,
        wall: 2,
      });
      expect(r.winner).toBe("defender");
      defenders = r.defender.map((s) => stack(s.owner, s.unit, ...s.survived));
      if (wave === 1) expect(survivorsOf(r.defender)).toEqual({ guard: 47, raider: 44 });
    }
    expect(defenders.map((s) => [s.unit, ...s.groups])).toEqual([
      ["guard", 5],
      ["raider", 5],
    ]);
    const r = battle({
      attacker: [stack("p1", "raider", 70), stack("p1", "settler", 1)],
      defender: defenders,
      hall: 7,
      wall: 2,
    });
    expect(r.land).toMatchObject({ D: 346, winner: "attacker", q: 61 });
    expect(survived(r, "attacker", "p1", "settler")).toEqual([1]);
  });

  test("day-7 capital: wave 1 kills 58%, wave 2 wins against D = 3525 (q = 344, 103 lost)", () => {
    const first = battle({
      attacker: [stack("p1", "raider", 300)],
      defender: [stack("p2", "guard", 200), stack("p2", "raider", 200)],
      hall: 10,
      wall: 10,
    });
    expect(first.land).toMatchObject({ A: 6000, D: 7875, winner: "defender", q: 579 });
    expect(survivorsOf(first.defender)).toEqual({ guard: 84, raider: 84 });
    const second = battle({
      attacker: [stack("p1", "raider", 300), stack("p1", "settler", 1)],
      defender: first.defender.map((s) => stack(s.owner, s.unit, ...s.survived)),
      hall: 10,
      wall: 10,
    });
    expect(second.land).toMatchObject({ D: 3525, winner: "attacker", q: 344 });
    expect(lost(second, "attacker", "p1", "raider")).toEqual([103]);
    expect(survived(second, "attacker", "p1", "settler")).toEqual([1]);
  });

  test("maxed turtle: 400 + 400 + 150 raiders across water; wave 3 wins with q = 555", () => {
    let guards = 440;
    for (const expected of [288, 62]) {
      const r = battle({
        acrossWater: true,
        attacker: [stack("p1", "raider", 400), stack("p1", "transport", 20)],
        defender: [stack("p2", "guard", guards)],
        hall: 10,
        wall: 10,
      });
      expect(r.naval).toBeNull();
      expect(r.winner).toBe("defender");
      guards = survived(r, "defender", "p2", "guard")[0]!;
      expect(guards).toBe(expected);
    }
    const r = battle({
      acrossWater: true,
      attacker: [stack("p1", "raider", 150), stack("p1", "transport", 8)],
      defender: [stack("p2", "guard", guards)],
      hall: 10,
      wall: 10,
    });
    expect(r.land).toMatchObject({ D: 2235, winner: "attacker", q: 555 });
  });

  test("the Crown: D = 10187, Nd = 500; 11 warships lose 9, 16 lose 6; 500 raiders kill 96%", () => {
    const crown = [stack(NEUTRAL, "guard", 400), stack(NEUTRAL, "warship", 10)];
    const strike = (ships: number) =>
      resolveBattle(d, {
        kind: "city",
        moralePm: moralePm(d, 8, null),
        acrossWater: true,
        attacker: [stack("p1", "warship", ships)],
        defender: crown,
        hall: 5,
        wall: 5,
      });
    expect(strike(10).naval).toMatchObject({ Na: 500, Nd: 500, winner: "defender" });
    expect(strike(11).naval).toMatchObject({ Na: 550, Nd: 500, winner: "attacker", q: 826 });
    expect(lost(strike(11), "attacker", "p1", "warship")).toEqual([9]);
    expect(lost(strike(16), "attacker", "p1", "warship")).toEqual([6]);
    const soften = battle({
      attacker: [stack("p1", "raider", 500)],
      defender: crown,
      hall: 5,
      wall: 5,
    });
    expect(soften.land).toMatchObject({ A: 10000, D: 10187, winner: "defender", q: 962 });
    expect(lost(soften, "defender", NEUTRAL, "guard")).toEqual([385]);
    expect(battleCredit(stats, soften, null).defenders).toEqual([]);
    expect(battleCredit(stats, soften, null).attackerByOwner).toEqual([
      { owner: NEUTRAL, pop: 385 },
    ]);
  });
});

describe("§8.7 loot", () => {
  test("raid economics: 100 raiders at 2:1 / 3:1 / 4:1 carry 3750 / 4450 / 4700", () => {
    for (const [odds, lostRaiders, carried] of [
      [2, 25, 3750],
      [3, 11, 4450],
      [4, 6, 4700],
    ] as const) {
      const q = lossPm(1000, 1000 * odds);
      expect(cas(100, q)).toBe(lostRaiders);
      expect(carryOf(stats, { raider: 100 - lostRaiders })).toBe(carried);
    }
  });

  test("100 per warehouse level is safe; a proportional share when the loot exceeds the carry", () => {
    expect(lootOf(d, { wood: 300, stone: 100, gold: 0 }, 2, 1000)).toEqual({
      wood: 100,
      stone: 0,
      gold: 0,
    });
    expect(lootOf(d, { wood: 1100, stone: 600, gold: 100 }, 1, 900)).toEqual({
      wood: 600,
      stone: 300,
      gold: 0,
    });
    fc.assert(
      fc.property(
        fc.record({
          wood: fc.integer({ min: 0, max: 9460 }),
          stone: fc.integer({ min: 0, max: 9460 }),
          gold: fc.integer({ min: 0, max: 9460 }),
        }),
        fc.integer({ min: 0, max: 10 }),
        fc.integer({ min: 0, max: 100000 }),
        (stock, warehouse, carry) => {
          const loot = lootOf(d, stock, warehouse, carry);
          expect(loot.wood + loot.stone + loot.gold).toBeLessThanOrEqual(carry);
          for (const r of ["wood", "stone", "gold"] as const) {
            expect(loot[r]).toBeGreaterThanOrEqual(0);
            expect(loot[r]).toBeLessThanOrEqual(Math.max(0, stock[r] - 100 * warehouse));
          }
        },
      ),
    );
  });
});

describe("§8.8 battle points", () => {
  test("with no defending pop, the defender credit goes to the fallback owner", () => {
    const r = battle({ attacker: [stack("p1", "raider", 3)], defender: [] });
    expect(battleCredit(stats, r, "p2")).toEqual({
      attackerByOwner: [],
      defenders: [{ owner: "p2", points: 3 }],
    });
    expect(battleCredit(stats, r, null).defenders).toEqual([]);
  });
});

// P13: survivors + losses = initial per stack and per group; adding attackers never lowers attacker
// strength; walls never help the attacker.

const LAND = ["guard", "raider", "settler"] as const;
const ALL = [...LAND, "transport", "warship"] as const;

const groupsArb = fc.array(fc.integer({ min: 0, max: 400 }), { minLength: 1, maxLength: 3 });
const sideArb = (owners: readonly string[], units: readonly string[]) =>
  fc.array(
    fc.record({
      owner: fc.constantFrom(...owners),
      unit: fc.constantFrom(...units),
      groups: groupsArb,
    }),
    { maxLength: 6 },
  );

const battleArb = fc.record({
  kind: fc.constantFrom<BattleInput["kind"]>("city", "relief", "homecoming"),
  moralePm: fc.integer({ min: 700, max: 1000 }),
  acrossWater: fc.boolean(),
  attacker: fc
    .array(fc.record({ unit: fc.constantFrom(...ALL), n: fc.integer({ min: 0, max: 600 }) }), {
      maxLength: 5,
    })
    .map((xs) => xs.map((x) => stack("p1", x.unit, x.n))),
  defender: sideArb(["p2", "p3", NEUTRAL], ALL),
  hall: fc.integer({ min: 0, max: 10 }),
  wall: fc.integer({ min: 0, max: 10 }),
});

function total(stacks: readonly StackOutcome[]): number {
  return stacks.reduce((s, x) => s + x.survived.reduce((a, b) => a + b, 0), 0);
}

describe("P13", () => {
  test("survivors + losses = initial, per stack and per group; a stack loses 0, cas(n, q) or all", () => {
    fc.assert(
      fc.property(battleArb, (input) => {
        const r = resolveBattle(d, input);
        for (const [side, stacks] of [
          ["attacker", input.attacker],
          ["defender", input.defender],
        ] as const) {
          for (const [i, s] of r[side].entries()) {
            expect(s.before).toEqual(stacks[i]!.groups);
            for (const [g, before] of s.before.entries()) {
              expect(s.lost[g]!).toBeGreaterThanOrEqual(0);
              expect(s.survived[g]!).toBeGreaterThanOrEqual(0);
              expect(s.lost[g]! + s.survived[g]!).toBe(before);
            }
            const n = s.before.reduce((a, b) => a + b, 0);
            const l = s.lost.reduce((a, b) => a + b, 0);
            const qs = [r.naval?.q, r.land?.q].filter((q): q is number => q !== undefined);
            const allowed = new Set([0, n, ...qs.map((q) => cas(n, q))]);
            if (qs.length === 2) allowed.add(cas(n, qs[0]!) + cas(n - cas(n, qs[0]!), qs[1]!));
            expect(allowed.has(l)).toBe(true);
          }
        }
      }),
      { numRuns: 500 },
    );
  });

  test("adding attackers never lowers attacker strength", () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.constantFrom(...ALL), fc.integer({ min: 0, max: 1000 })),
        fc.constantFrom(...ALL),
        fc.integer({ min: 1, max: 500 }),
        fc.integer({ min: 700, max: 1000 }),
        (units, extra, more, morale) => {
          const bigger = { ...units, [extra]: (units[extra] ?? 0) + more };
          expect(landAttack(stats, bigger, morale)).toBeGreaterThanOrEqual(
            landAttack(stats, units, morale),
          );
          const run = (u: Record<string, number>) =>
            resolveBattle(d, {
              kind: "city",
              moralePm: morale,
              acrossWater: true,
              attacker: Object.entries(u).map(([unit, n]) => stack("p1", unit, n)),
              defender: [stack("p2", "warship", 3), stack("p2", "guard", 50)],
              hall: 3,
              wall: 2,
            });
          const a = run(units);
          const b = run(bigger);
          expect(b.naval?.Na ?? 0).toBeGreaterThanOrEqual(a.naval?.Na ?? 0);
          if (a.land !== null && b.land !== null) expect(b.land.A).toBeGreaterThanOrEqual(a.land.A);
        },
      ),
      { numRuns: 300 },
    );
  });

  test("walls never help the attacker", () => {
    fc.assert(
      fc.property(battleArb, fc.integer({ min: 1, max: 5 }), (input, more) => {
        const low = resolveBattle(d, input);
        const high = resolveBattle(d, { ...input, wall: input.wall + more });
        if (low.land !== null && high.land !== null) {
          expect(high.land.D).toBeGreaterThanOrEqual(low.land.D);
        }
        if (high.attackerWonLand) expect(low.attackerWonLand).toBe(true);
        expect(total(high.attacker)).toBeLessThanOrEqual(total(low.attacker));
        expect(total(high.defender)).toBeGreaterThanOrEqual(total(low.defender));
      }),
      { numRuns: 500 },
    );
  });
});
