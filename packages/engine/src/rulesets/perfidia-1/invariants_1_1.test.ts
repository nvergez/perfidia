import { describe, expect, test } from "bun:test";
import { EngineBug } from "@perfidia/engine/kernel";
import { addAlliance, addBuildItem } from "@perfidia/engine/testing";
import { PerfidiaExtSchema } from "./ext.ts";
import { initialExt11, Perfidia11ExtSchema } from "./ext_1_1.ts";
import { initialExt } from "./ext.ts";
import {
  besiege11,
  city11,
  countdown11,
  load11,
  taken11,
  world11,
  type World11,
} from "./fixtures_1_1.test.ts";
import { perfidia11Invariants } from "./invariants_1_1.ts";

// perfidia-1@1.1.0's invariants: 1.0.0's read the 1.1.0 ext (a silent skip would hide every
// corruption), and the conquest records stay consistent with the cities and the players.

const T = 300000;
const O = { "victory.dominationPm": 100, "victory.dominationMinPerPlayer": 1 };

/** A consistent world: c2 besieged by p1, c3 taken by p3 from p2, a countdown of a1 = {p3, p4}. */
function base(): World11 {
  const w = world11({ now: T, overrides: O });
  city11(w, { id: "c1", owner: "p1", island: "i1" });
  city11(w, { id: "c2", owner: "p2", island: "i2" });
  for (let i = 0; i < 6; i += 1) {
    city11(w, { id: `c${10 + i}`, owner: i < 4 ? "p3" : "p4", island: `i${1 + (i % 4)}` });
  }
  city11(w, { id: "c3", owner: "p3", island: "i3" });
  taken11(w, "c3", "p3", ["p2"]);
  city11(w, { id: "c4", owner: "p4", island: "i4" });
  taken11(w, "c4", "p4", ["p5"]);
  city11(w, { id: "c5", owner: "p5", island: "i3" });
  city11(w, { id: "c6", owner: "p6", island: "i4" });
  besiege11(w, {
    city: "c2",
    by: "p1",
    garrison: [{ home: "c1", units: { settler: 1, peltast: 3 } }],
    endsAt: T + 21600,
  });
  addAlliance(w.state, "South", ["p3", "p4"]);
  countdown11(w, { bloc: "a1", members: ["p3", "p4"], endsAt: T + 86400 });
  return w;
}

function failures(w: World11): string {
  try {
    load11(w, O).checkInvariants("step");
    return "";
  } catch (error) {
    if (!(error instanceof EngineBug)) throw error;
    return error.message;
  }
}

const CORRUPTIONS: readonly { name: string; plant: (w: World11) => void; caught: string }[] = [
  {
    name: "a queue item in a besieged city (1.0.0's invariant, on the 1.1.0 ext)",
    plant: (w) => {
      addBuildItem(w.state, w.rules, "c2", "acropolis");
    },
    caught: "perfidia-1.sieges: siege of c2: 1 queue items in a besieged city",
  },
  {
    name: "a countdown whose members are not its bloc's",
    plant: (w) => {
      const cd = w.ext.domination.countdowns[0];
      if (cd !== undefined) cd.members = ["p3"];
    },
    caught: "perfidia-1.domination: countdown of a1: members p3, the bloc has p3,p4",
  },
  {
    name: "a conquest record of another owner",
    plant: (w) => {
      taken11(w, "c5", "p1", ["p6"]);
    },
    caught: "perfidia-1.conquests: conquest record of c5: taken by p1, but the owner is p5",
  },
  {
    name: "a conquest record of no city",
    plant: (w) => {
      taken11(w, "c99", "p1", ["p6"]);
    },
    caught: "perfidia-1.conquests: conquest record of c99: no such city",
  },
  {
    name: "former owners out of order",
    plant: (w) => {
      taken11(w, "c3", "p3", ["p5", "p2"]);
    },
    caught:
      "perfidia-1.conquests: conquest record of c3: former owners p5,p2 are not sorted and unique",
  },
  {
    name: "a former owner that is no player",
    plant: (w) => {
      taken11(w, "c3", "p3", ["p2", "p9"]);
    },
    caught: "perfidia-1.conquests: conquest record of c3: former owner p9 is not a player",
  },
];

describe("perfidia-1@1.1.0 invariants", () => {
  test("a consistent world passes", () => {
    expect(failures(base())).toBe("");
  });

  for (const c of CORRUPTIONS) {
    test(`catch ${c.name}`, () => {
      const w = base();
      c.plant(w);
      expect(failures(w)).toContain(c.caught);
    });
  }

  test("every invariant of the list reports on a broken 1.1.0 state, none is skipped", () => {
    const names = perfidia11Invariants.map((i) => i.name);
    expect(names).toEqual([
      "perfidia-1.sieges",
      "perfidia-1.siege-events",
      "perfidia-1.domination",
      "perfidia-1.bookkeeping",
      "perfidia-1.conquests",
    ]);
  });

  test("the two versions' ext schemas reject each other's ext", () => {
    const players = ["p1", "p2"] as const;
    expect(PerfidiaExtSchema.safeParse(initialExt11(players, players)).success).toBe(false);
    expect(Perfidia11ExtSchema.safeParse(initialExt(players, players)).success).toBe(false);
    expect(Perfidia11ExtSchema.safeParse(initialExt11(players, players)).success).toBe(true);
  });
});
