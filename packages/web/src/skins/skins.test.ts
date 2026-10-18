import { describe, expect, test } from "bun:test";
import {
  NAMES_1_0_0,
  NAMES_1_1_0,
  buildingIds,
  kindIds,
  unitIds,
} from "@perfidia/engine/rulesets/perfidia-1";
import { RULESETS } from "@perfidia/engine/rulesets";
import { field, isRecord } from "../lib/json.ts";
import { frame, meta } from "../testkit.test.ts";
import { skinFor } from "./index.ts";

const WAR_EXT = {
  tiebreak: ["p2", "p1"],
  domination: {
    open: true,
    need: 16,
    needTaken: 2,
    slots: 43,
    blocs: [
      { key: "a1", members: ["p1", "p4"], cities: 16, taken: 2 },
      { key: "p3", members: ["p3"], cities: 4, taken: 0 },
    ],
    countdowns: [
      {
        key: "a1",
        members: ["p1", "p4"],
        cities: 16,
        taken: 2,
        need: 16,
        needTaken: 2,
        ends: [498_807, "D6 18:33:27"],
      },
    ],
  },
};

describe("the perfidia-1 skin", () => {
  test("labels every id of 1.1.0 and 1.0.0 (the ruleset's names table), none raw", () => {
    for (const names of [NAMES_1_1_0, NAMES_1_0_0]) {
      const skin = skinFor(names.ref);
      expect(skin.id).toBe("perfidia-1");
      expect(skin.buildingOrder).toEqual(buildingIds(names));
      expect(skin.unitOrder).toEqual(unitIds(names));
      for (const id of buildingIds(names))
        expect([id, skin.building(id).name === id]).toEqual([id, false]);
      for (const id of unitIds(names)) expect([id, skin.unit(id).name === id]).toEqual([id, false]);
      for (const kind of kindIds(names))
        expect([kind, skin.islandKind(kind).name === kind]).toEqual([kind, false]);
      expect(skin.isPrizeIsland(names.prize)).toBe(true);
    }
    const greek = skinFor("perfidia-1@1.1.0");
    expect([
      greek.building("acropolis").name,
      greek.unit("trireme").name,
      greek.islandKind("olympus").name,
    ]).toEqual(["Acropolis", "Trireme", "Mount Olympus"]);
    expect(greek.prizeName).toBe("Mount Olympus");
    expect(greek.queue("build").name).toBe("Construction");
  });

  test("its recruit queues are the ruleset's", () => {
    const skin = skinFor("perfidia-1@1.1.0");
    const r = RULESETS.find((x) => x.ref === "perfidia-1@1.1.0");
    if (r === undefined) throw new Error("no 1.1.0");
    const units = field(r.defaults, "units");
    const queues = new Set(
      (isRecord(units) ? Object.values(units) : []).flatMap((u) => {
        const q = field(u, "queue");
        return typeof q === "string" ? [q] : [];
      }),
    );
    expect(queues.size).toBeGreaterThan(0);
    for (const q of queues) expect([q, skin.queue(q).name === q]).toEqual([q, false]);
  });

  test("the rule sentence takes its numbers from the match (war golden: 6 days)", () => {
    const skin = skinFor("perfidia-1@1.1.0");
    const war = meta({ matchEnd: 518_400 });
    expect(skin.ruleSentence(war, frame(0, 0, { ext: WAR_EXT }))).toBe(
      "A bloc wins by holding 16 of the 43 city slots, 2 of them taken by conquest, for 24 h (from D4 00:00, start by D6 00:00); otherwise the highest score at the end of day 6 wins.",
    );
    const seven = meta({ matchEnd: 604_800 });
    const twelve = { domination: { ...WAR_EXT.domination, need: 26, slots: 73 } };
    expect(skin.ruleSentence(seven, frame(0, 0, { ext: twelve }))).toBe(
      "A bloc wins by holding 26 of the 73 city slots, 2 of them taken by conquest, for 24 h (from D4 00:00, start by D7 00:00); otherwise the highest score at the end of day 7 wins.",
    );
    const other = meta({ matchEnd: 432_000, dominationStart: 172_800, dominationHold: 43_200 });
    expect(
      skin.ruleSentence(
        other,
        frame(0, 0, { ext: { domination: { ...WAR_EXT.domination, needTaken: 0 } } }),
      ),
    ).toBe(
      "A bloc wins by holding 16 of the 43 city slots for 12 h (from D3 00:00, start by D5 12:00); otherwise the highest score at the end of day 5 wins.",
    );
    const short = meta({ matchEnd: 86_400 });
    expect(skin.ruleSentence(short, frame(0, 0, { ext: WAR_EXT }))).toStartWith(
      "The highest score at the end of day 1 wins (this match ends before",
    );
  });

  test("domination, cities and players read from ext", () => {
    const skin = skinFor("perfidia-1@1.1.0");
    const d = skin.domination(meta({ matchEnd: 518_400 }), frame(0, 0, { ext: WAR_EXT }));
    expect(d).toMatchObject({
      open: true,
      need: 16,
      needTaken: 2,
      slots: 43,
      opensAt: 259_200,
      hold: 86_400,
      startBy: 432_000,
    });
    expect(d?.blocs[0]).toEqual({ key: "a1", members: ["p1", "p4"], cities: 16, taken: 2 });
    expect(d?.countdowns[0]).toEqual({
      key: "a1",
      members: ["p1", "p4"],
      cities: 16,
      taken: 2,
      endsAt: 498_807,
    });
    expect(skin.domination(meta(), frame())).toBeNull();
    const city = {
      ...cityOf(),
      tag: "olympus",
      ext: {
        points: 150,
        olympus: true,
        taken: true,
        former: ["p2"],
        siege: { by: "p3", ends: [600, "D1 00:10"] },
      },
    };
    expect(skin.city(city)).toEqual({
      points: 150,
      prize: true,
      taken: true,
      former: ["p2"],
      siege: { by: "p3", endsAt: 600 },
    });
    expect(skin.player({ ...frame().players.p1!, ext: { tiebreak: 2, taken: 1 } })).toEqual({
      tiebreak: 2,
      taken: 1,
    });
  });

  test("battle reports as rows", () => {
    const skin = skinFor("perfidia-1@1.1.0");
    const r = skin.report("battle_report", {
      attacker: "p6",
      defender: "p5",
      city: "c17",
      kind: "city",
      winner: "attacker",
      loot: { wood: 5, stone: 0, gold: 1 },
      wall: { before: 2, after: 1 },
      siege: "started",
      stacks: [
        { owner: "p6", side: "attacker", unit: "peltast", before: 110, lost: 0, survived: 110 },
      ],
    });
    expect(r.title).toBe("Battle at c17: assault");
    expect(r.rows.find((x) => x.label === "Winner")?.value).toBe("p6");
    expect(r.stacks).toEqual([
      { owner: "p6", side: "attacker", unit: "Peltast", before: 110, lost: 0, survived: 110 },
    ]);
  });
});

describe("the default skin", () => {
  test("raw ids humanised, no domination, the score rule", () => {
    const skin = skinFor("sandbox-1@1.0.0");
    expect(skin.id).toBe("default");
    expect(skin.building("lumber_camp").name).toBe("Lumber camp");
    expect(skin.domination(meta(), frame())).toBeNull();
    expect(skin.ruleSentence(meta({ matchEnd: 172_800 }), frame())).toBe(
      "The highest score at the end of day 2 wins.",
    );
    expect(skin.city({ ...cityOf(), ext: { points: 12 } }).points).toBe(12);
    expect(skinFor("sandbox-1@1.0.0")).toBe(skin);
  });
});

function cityOf() {
  return {
    id: "c1" as const,
    name: "c1",
    owner: "p1" as const,
    island: "i1" as const,
    slot: 0,
    capitalOf: null,
    tag: null,
    buildings: {},
    units: {},
    stationed: [],
    stock: { wood: 0, stone: 0, gold: 0 },
    stockAt: 0,
    perHour: { wood: 0, stone: 0, gold: 0 },
    cap: 100,
    pop: { used: 0, cap: 10 },
    ext: {},
  };
}
