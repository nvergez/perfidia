import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { createMatch } from "@perfidia/engine/kernel";
import { addAlliance } from "@perfidia/engine/testing";
import { idKeyFromSeed } from "@perfidia/engine/core";
import { compareIds, type Json, type PlayerId } from "@perfidia/protocol";
import { blocsOf } from "./domination.ts";
import { PERFIDIA_1_1_DEFAULTS } from "./config_1_1.ts";
import {
  blocHold,
  blocOf,
  holdByOwner,
  holdOf,
  holds,
  lastCountdownStart,
  mapSlots,
  takenNow,
  totalSlots,
} from "./domination_1_1.ts";
import { initialExt11, isTaken, type Perfidia11Ext, recordConquest } from "./ext_1_1.ts";
import { testDomain } from "./fixtures.test.ts";
import { city11, taken11, world11 } from "./fixtures_1_1.test.ts";
import { perfidia1_1_1_0 } from "./v1_1_0.ts";

// Domination by conquest (perfidia-1@1.1.0 §13.3): the taken flag of a city (its owner conquered it
// and no member of the owner's bloc ever owned it), the map's city slots, and what each player and
// bloc holds.

const P11 = perfidia1_1_1_0;

function ext(): Perfidia11Ext {
  return initialExt11(["p1", "p2", "p3", "p4"], ["p1", "p2", "p3", "p4"]);
}

describe("the taken flag", () => {
  test("a first capture is taken; a recapture by a former owner is not", () => {
    const x = ext();
    recordConquest(x, "c5", "p2", "p1");
    expect(x.conquests["c5"]).toEqual({ by: "p1", former: ["p2"] });
    expect(isTaken(x, "c5", "p1", ["p1"])).toBe(true);
    recordConquest(x, "c5", "p1", "p2");
    expect(x.conquests["c5"]).toEqual({ by: "p2", former: ["p1", "p2"] });
    expect(isTaken(x, "c5", "p2", ["p2"])).toBe(false);
  });

  test("A → C → A: C takes it while it holds it, then A's reconquest is not taken", () => {
    const x = ext();
    recordConquest(x, "c5", "p4", "p1");
    recordConquest(x, "c5", "p1", "p3");
    expect(isTaken(x, "c5", "p3", ["p3"])).toBe(true);
    recordConquest(x, "c5", "p3", "p1");
    expect(x.conquests["c5"]).toEqual({ by: "p1", former: ["p1", "p3", "p4"] });
    expect(isTaken(x, "c5", "p1", ["p1"])).toBe(false);
  });

  test("taken, lost, retaken: the first conqueror's genuine reconquest does not count again", () => {
    const x = ext();
    recordConquest(x, "c5", "p4", "p1");
    recordConquest(x, "c5", "p1", "p2");
    recordConquest(x, "c5", "p2", "p1");
    expect(isTaken(x, "c5", "p1", ["p1"])).toBe(false);
  });

  test("a city a member of the owner's bloc ever owned is not taken for that bloc", () => {
    // p2 loses c5 to p3; p2's ally p1 takes it back from p3: the bloc owned it before.
    const x = ext();
    recordConquest(x, "c5", "p2", "p3");
    recordConquest(x, "c5", "p3", "p1");
    expect(x.conquests["c5"]).toEqual({ by: "p1", former: ["p2", "p3"] });
    expect(isTaken(x, "c5", "p1", ["p1", "p2"])).toBe(false);
    expect(isTaken(x, "c5", "p1", ["p1"])).toBe(true);
    // A staged trade: p1 takes c6 from p2, then they ally. Taken while apart, not once allied.
    recordConquest(x, "c6", "p2", "p1");
    expect(isTaken(x, "c6", "p1", ["p1"])).toBe(true);
    expect(isTaken(x, "c6", "p1", ["p1", "p2"])).toBe(false);
    // After a betrayal the victim is outside the betrayer's bloc: its city counts.
    recordConquest(x, "c8", "p3", "p1");
    expect(isTaken(x, "c8", "p1", ["p1", "p4"])).toBe(true);
  });

  test("Olympus, taken from no owner, is taken with no former owner", () => {
    const x = ext();
    recordConquest(x, "c7", null, "p1");
    expect(x.conquests["c7"]).toEqual({ by: "p1", former: [] });
    expect(isTaken(x, "c7", "p1", ["p1"])).toBe(true);
  });

  test("a city without a record, or a record of another owner, is not taken", () => {
    const x = ext();
    expect(isTaken(x, "c1", "p1", ["p1"])).toBe(false);
    recordConquest(x, "c5", "p2", "p1");
    expect(isTaken(x, "c5", "p3", ["p3"])).toBe(false);
    expect(isTaken(x, "c5", null, [])).toBe(false);
  });

  test("each player takes a city at most once, whatever the order of captures", () => {
    const players: PlayerId[] = ["p1", "p2", "p3", "p4"];
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...players), { minLength: 1, maxLength: 12 }), (seq) => {
        const x = ext();
        let owner: PlayerId = "p4";
        const takenBy = new Map<PlayerId, number>();
        for (const to of seq) {
          if (to === owner) continue;
          recordConquest(x, "c5", owner, to);
          owner = to;
          if (isTaken(x, "c5", to, [to])) takenBy.set(to, (takenBy.get(to) ?? 0) + 1);
          const rec = x.conquests["c5"];
          expect(rec?.by).toBe(to);
          expect(rec?.former).toEqual([...new Set(rec?.former)].toSorted(compareIds));
        }
        for (const n of takenBy.values()) expect(n).toBe(1);
        expect(takenBy.has("p4")).toBe(false);
      }),
      { numRuns: 300 },
    );
  });
});

describe("the map's city slots", () => {
  test("mapSlots is the sum of the slots of the world created, under kind overrides", () => {
    const cases: Readonly<Record<string, Json>>[] = [
      {},
      { "map.kinds.backyard.slots": 0 },
      { "map.kinds.hub.slots": 2 },
      { "map.hubMaxPlayers": 0 },
      { "map.kinds.olympus.slots": 3, "map.kinds.inner.slots": 4 },
    ];
    for (const overrides of cases) {
      for (const n of [6, 7, 8, 12]) {
        const seats = Array.from({ length: n }, (_, i): { id: PlayerId } => ({ id: `p${i + 1}` }));
        const setup = { ruleset: P11.ref, overrides, seed: 3, idKey: idKeyFromSeed(3), seats };
        const m = createMatch(setup, P11, testDomain, { invariants: "off" }).read();
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- 1.1.0's own config
        const config = m.config as typeof P11.defaults;
        expect([overrides, n, mapSlots(config, n)]).toEqual([overrides, n, totalSlots(m.state)]);
      }
    }
  });
});

describe("holds", () => {
  test("holdByOwner and blocHold equal a scan per bloc; a besieged city counts for its owner", () => {
    const w = world11();
    city11(w, { id: "c1", owner: "p1", island: "i1" });
    city11(w, { id: "c2", owner: "p1", island: "i2" });
    city11(w, { id: "c3", owner: "p2", island: "i3" });
    city11(w, { id: "c4", owner: "p3", island: "i4" });
    city11(w, { id: "c5", owner: null, island: "i4", tag: "olympus" });
    taken11(w, "c2", "p1", ["p4"]);
    taken11(w, "c3", "p2", ["p2"]);
    w.ext.sieges["c1"] = { by: "p3", startedAt: 1, endsAt: 2, seq: 1 };
    const byOwner = holdByOwner(w.state, w.ext);
    expect([...byOwner].toSorted(([a], [b]) => compareIds(a, b))).toEqual([
      ["p1", { cities: 2, taken: 1 }],
      ["p2", { cities: 1, taken: 0 }],
      ["p3", { cities: 1, taken: 0 }],
    ]);
    for (const bloc of blocsOf(w.state)) {
      let cities = 0;
      let taken = 0;
      for (const c of Object.values(w.state.cities)) {
        if (c.owner === null || !bloc.members.includes(c.owner)) continue;
        cities += 1;
        if (isTaken(w.ext, c.id, c.owner, bloc.members)) taken += 1;
      }
      expect(blocHold(byOwner, bloc.members)).toEqual({ cities, taken });
    }
    expect(holds({ cities: 2, taken: 1 }, { cities: 2, taken: 1 })).toBe(true);
    expect(holds({ cities: 2, taken: 1 }, { cities: 3, taken: 0 })).toBe(false);
    expect(holds({ cities: 2, taken: 0 }, { cities: 1, taken: 5 })).toBe(false);
  });

  test("a city taken from a player stops counting once that player joins the owner's bloc", () => {
    const w = world11();
    city11(w, { id: "c1", owner: "p1", island: "i1" });
    city11(w, { id: "c2", owner: "p1", island: "i2" });
    city11(w, { id: "c3", owner: "p2", island: "i3" });
    taken11(w, "c2", "p1", ["p2"]);
    expect(holdOf(holdByOwner(w.state, w.ext), "p1")).toEqual({ cities: 2, taken: 1 });
    expect(takenNow(w.state, w.ext, "c2")).toBe(true);
    expect(blocOf(w.state, "p1")).toEqual(["p1"]);
    addAlliance(w.state, "North", ["p1", "p2"]);
    expect(blocOf(w.state, "p2")).toEqual(["p1", "p2"]);
    expect(blocOf(w.state, "p3")).toEqual(["p3"]);
    expect(holdOf(holdByOwner(w.state, w.ext), "p1")).toEqual({ cities: 2, taken: 0 });
    expect(takenNow(w.state, w.ext, "c2")).toBe(false);
    expect(takenNow(w.state, w.ext, "c1")).toBe(false);
  });

  test("lastCountdownStart: the last second a countdown can still end by matchEnd", () => {
    expect(lastCountdownStart(PERFIDIA_1_1_DEFAULTS.time)).toBe(518400);
    expect(lastCountdownStart({ matchEnd: 345600, dominationHold: 86400 })).toBe(259200);
  });
});
