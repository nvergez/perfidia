import { describe, expect, test } from "bun:test";
import type { ReadCtx } from "@perfidia/engine/contracts";
import { addAlliance } from "@perfidia/engine/testing";
import { CityIdSchema } from "@perfidia/protocol";
import {
  besiege11,
  city11,
  countdown11,
  load11,
  taken11,
  world11,
  type World11,
} from "./fixtures_1_1.test.ts";
import { perfidia11Visibility as V } from "./visibility_1_1.ts";
import type { PRead11 } from "./victory_1_1.ts";

// The public extras of perfidia-1@1.1.0 (§12, §13.2): city points with the Olympus bonus, taken
// cities and their former owners, each player's taken cities, every bloc's cities and taken cities
// against the threshold, the countdowns and the seat's own bloc in its briefing.

const T = 300000;
const O = { "victory.dominationPm": 100, "victory.dominationMinPerPlayer": 1 };

function scene(): World11 {
  const w = world11({ now: T, overrides: O });
  city11(w, { id: "c1", owner: "p1", island: "i1", buildings: { acropolis: 2 } });
  city11(w, { id: "c2", owner: "p1", island: "i2" });
  taken11(w, "c2", "p1", ["p3"]);
  city11(w, { id: "c3", owner: "p2", island: "i3" });
  // c4 went p3 → p2 → p3: p3 owned it before, so it is not taken.
  city11(w, { id: "c4", owner: "p3", island: "i3" });
  taken11(w, "c4", "p3", ["p2", "p3"]);
  city11(w, { id: "c7", owner: "p4", island: "i4", tag: "olympus" });
  taken11(w, "c7", "p4", []);
  for (const p of ["p5", "p6"] as const) {
    city11(w, { id: CityIdSchema.parse(`c1${p.slice(1)}`), owner: p, island: "i4" });
  }
  addAlliance(w.state, "North", ["p1", "p2"]);
  return w;
}

function read(w: World11): PRead11 {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a 1.1.0 match reads with 1.1.0's types
  return load11(w, O).read() as unknown as PRead11;
}

describe("public extras of 1.1.0", () => {
  test("a city: its points, Olympus, taken and its former owners", () => {
    const r = read(scene());
    expect(V.publicCity(r, "p6", "c1")).toEqual({ points: 102 });
    expect(V.publicCity(r, "p6", "c2")).toEqual({ points: 100, taken: true, former: ["p3"] });
    expect(V.publicCity(r, "p6", "c4")).toEqual({ points: 100, former: ["p2", "p3"] });
    expect(V.publicCity(r, "p6", "c7")).toEqual({ points: 200, olympus: true, taken: true });
  });

  test("a besieged city keeps its siege (by, ends) next to the conquest record", () => {
    const w = scene();
    besiege11(w, {
      city: "c2",
      by: "p5",
      garrison: [{ home: "c15", units: { settler: 1 } }],
      endsAt: T + 21600,
    });
    expect(V.publicCity(read(w), "p6", "c2")).toEqual({
      points: 100,
      taken: true,
      former: ["p3"],
      siege: { by: "p5", ends: [T + 21600, "D4 17:20"] },
    });
  });

  test("a player: its tie-break position and taken cities", () => {
    const r = read(scene());
    expect(V.publicPlayer(r, "p1")).toEqual({ tiebreak: 1, taken: 1 });
    expect(V.publicPlayer(r, "p3")).toEqual({ tiebreak: 3, taken: 0 });
    expect(V.publicPlayer(r, "p4")).toEqual({ tiebreak: 4, taken: 1 });
  });

  test("the match: the threshold, the map's slots, every bloc and the countdowns", () => {
    const w = scene();
    countdown11(w, { bloc: "a1", members: ["p1", "p2"], endsAt: T + 5000 });
    const m = V.publicMatch(read(w));
    expect(m).toEqual({
      tiebreak: ["p1", "p2", "p3", "p4", "p5", "p6"],
      domination: {
        open: true,
        need: 6,
        needTaken: 2,
        slots: 40,
        blocs: [
          { key: "a1", members: ["p1", "p2"], cities: 3, taken: 1 },
          { key: "p3", members: ["p3"], cities: 1, taken: 0 },
          { key: "p4", members: ["p4"], cities: 1, taken: 1 },
          { key: "p5", members: ["p5"], cities: 1, taken: 0 },
          { key: "p6", members: ["p6"], cities: 1, taken: 0 },
        ],
        countdowns: [
          {
            key: "a1",
            members: ["p1", "p2"],
            cities: 3,
            taken: 1,
            need: 6,
            needTaken: 2,
            ends: [T + 5000, "D4 12:43:20"],
          },
        ],
      },
    });
  });

  test("the briefing: the sieges held, the countdowns and the seat's own bloc", () => {
    const r = read(scene());
    expect(V.briefing?.(r, "p2")).toEqual({
      holding: [],
      countdowns: [],
      bloc: { key: "a1", members: ["p1", "p2"], cities: 3, taken: 1, need: 6, needTaken: 2 },
    });
    expect(V.briefing?.(r, "p5")).toMatchObject({
      bloc: { key: "p5", members: ["p5"], cities: 1, taken: 0 },
    });
  });

  test("views are the same for every viewer: they follow from public conquests only", () => {
    const r = read(scene());
    for (const city of ["c1", "c2", "c4", "c7"] as const) {
      const seen = (["p1", "p3", "p6"] as const).map((v) => V.publicCity(r, v, city));
      expect(seen[1]).toEqual(seen[0]);
      expect(seen[2]).toEqual(seen[0]);
    }
    const generic: ReadCtx = r;
    expect(generic.ruleset.ref).toBe("perfidia-1@1.1.0");
  });
});
