import { describe, expect, test } from "bun:test";
import { EngineBug } from "@perfidia/engine/kernel";
import { addAlliance, addBuildItem, addStationed, scheduleAt } from "@perfidia/engine/testing";
import { besiege, city, countdown, load, world, type World } from "./fixtures.test.ts";

// perfidia-1's invariants (docs/architecture.md §13.3) each catch a planted corruption, and a
// consistent state passes them.

const T = 300000;

/** A consistent world: c2 besieged by p1, a countdown of a1 = {p3, p4} (12 cities). */
function base(): World {
  const w = world({ now: T });
  city(w, { id: "c1", owner: "p1", island: "i1" });
  city(w, { id: "c2", owner: "p2", island: "i2" });
  for (let i = 0; i < 12; i += 1)
    city(w, { id: `c${10 + i}`, owner: i < 8 ? "p3" : "p4", island: `i${1 + (i % 4)}` });
  city(w, { id: "c5", owner: "p5", island: "i3" });
  city(w, { id: "c6", owner: "p6", island: "i4" });
  besiege(w, {
    city: "c2",
    by: "p1",
    garrison: [{ home: "c1", units: { settler: 1, raider: 3 } }],
  });
  addAlliance(w.state, "South", ["p3", "p4"]);
  countdown(w, { bloc: "a1", members: ["p3", "p4"] });
  return w;
}

function failures(w: World): string {
  try {
    load(w).checkInvariants("step");
    return "";
  } catch (error) {
    if (!(error instanceof EngineBug)) throw error;
    return error.message;
  }
}

const CORRUPTIONS: readonly { name: string; plant: (w: World) => void; caught: string }[] = [
  {
    name: "a garrison without a settler",
    plant: (w) => {
      const g = w.state.cities["c2"]?.stationed[0];
      if (g !== undefined) g.units = { raider: 3 };
      w.state.ledger["p1"] = { made: { raider: 3 }, gone: {} };
    },
    caught: "perfidia-1.sieges: siege of c2: the garrison has no settler",
  },
  {
    name: "a queue item in a besieged city",
    plant: (w) => {
      addBuildItem(w.state, w.rules, "c2", "hall");
    },
    caught: "perfidia-1.sieges: siege of c2: 1 queue items in a besieged city",
  },
  {
    name: "a besieger that owns the city",
    plant: (w) => {
      const c2 = w.state.cities["c2"];
      if (c2 !== undefined) c2.owner = "p1";
    },
    caught: "perfidia-1.sieges: siege of c2: p1 besieges its own city",
  },
  {
    name: "a hold group without a siege",
    plant: (w) => {
      addStationed(w.state, "c5", { owner: "p6", home: "c6", role: "hold", units: { raider: 1 } });
    },
    caught: "perfidia-1.sieges: c5: a hold group of p6 from c6 without its siege",
  },
  {
    name: "a siege whose siege_end event has another seq",
    plant: (w) => {
      const s = w.ext.sieges["c2"];
      if (s !== undefined) s.seq += 1000;
    },
    caught: "perfidia-1.siege-events: siege_end",
  },
  {
    name: "a siege without its siege_end event",
    plant: (w) => {
      w.state.queue = w.state.queue.filter((e) => e.kind !== "siege_end");
    },
    caught: "perfidia-1.siege-events: siege of c2: no matching siege_end event",
  },
  {
    name: "a countdown while domination is closed",
    plant: (w) => {
      w.ext.domination.open = false;
    },
    caught: "perfidia-1.domination: countdowns run while domination is closed",
  },
  {
    name: "a countdown whose members are not the bloc's",
    plant: (w) => {
      const c = w.ext.domination.countdowns[0];
      if (c !== undefined) c.members = ["p3"];
    },
    caught: "perfidia-1.domination: countdown of a1: members p3, the bloc has p3,p4",
  },
  {
    name: "a domination_end event without its countdown",
    plant: (w) => {
      scheduleAt(w.state, w.rules, "domination_end", T + 5000, "p6");
    },
    caught: "perfidia-1.domination: domination_end",
  },
  {
    name: "a domination_open timer still queued once open",
    plant: (w) => {
      scheduleAt(w.state, w.rules, "domination_open", T + 5000, "");
    },
    caught: "perfidia-1.domination: domination is open but domination_open is still queued",
  },
  {
    name: "a tie-break order that is not a permutation of the players",
    plant: (w) => {
      w.ext.tiebreak = ["p1", "p1", "p2", "p3", "p4", "p5"];
    },
    caught: "perfidia-1.bookkeeping: tie-break order",
  },
  {
    name: "battle points of a non-player",
    plant: (w) => {
      w.ext.battlePoints["p9"] = 4;
    },
    caught: "perfidia-1.bookkeeping: battle points of p9, who is not a player",
  },
  {
    name: "a frozen score of an alive player",
    plant: (w) => {
      w.ext.frozenScores["p5"] = { cityPoints: 105, battleScore: 0 };
    },
    caught: "perfidia-1.bookkeeping: frozen score of p5, who is still alive",
  },
  {
    name: "a frozen score of a non-player",
    plant: (w) => {
      w.ext.frozenScores["p9"] = { cityPoints: 105, battleScore: 0 };
    },
    caught: "perfidia-1.bookkeeping: frozen score of p9, who is not a player",
  },
  {
    name: "a relation that ended in the future",
    plant: (w) => {
      w.ext.relationEnds["p1|p2"] = T + 1;
    },
    caught: "perfidia-1.bookkeeping: relation p1|p2 ended at",
  },
];

describe("perfidia-1 invariants", () => {
  test("a consistent state with a siege and a countdown passes", () => {
    expect(failures(base())).toBe("");
  });

  for (const c of CORRUPTIONS) {
    test(`catch ${c.name}`, () => {
      const w = base();
      c.plant(w);
      expect(failures(w)).toContain(c.caught);
    });
  }
});
