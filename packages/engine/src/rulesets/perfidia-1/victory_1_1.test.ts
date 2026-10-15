import { describe, expect, test } from "bun:test";
import { foundCity, leaveAlliance } from "@perfidia/engine/std";
import { addAlliance, testStep } from "@perfidia/engine/testing";
import { CityIdSchema } from "@perfidia/protocol";
import { isTaken } from "./ext_1_1.ts";
import { ofType } from "./fixtures.test.ts";
import {
  besiege11,
  cities11,
  city11,
  countdown11,
  extOf11,
  load11,
  taken11,
  world11,
  type World11,
} from "./fixtures_1_1.test.ts";
import { countdownsQualifyProblems, type PRead11 } from "./victory_1_1.ts";

// Domination by conquest (perfidia-1@1.1.0 §13.3) through the kernel: the threshold counts the
// map's city slots (fixed), a bloc needs taken cities, conquests record who took a city and who
// owned it before, and every same-second rule of 1.0.0 still holds. The test map has 4 islands of
// 10 slots (40 slots); with dominationPm 100 and dominationMinPerPlayer 1 at N = 6, a bloc needs
// max(6, ceil(100 × 40 / 1000) = 4) = 6 cities, 2 of them taken.

const T = 300000;
const O = { "victory.dominationPm": 100, "victory.dominationMinPerPlayer": 1 };

/** p1 holds c1..c5 and c20 (taken from p3); p2 holds c30 and c31; p3..p6 one city each. */
function baseWorld(): World11 {
  const w = world11({ now: T, overrides: O });
  cities11(w, "p1", 1, 5);
  city11(w, { id: "c20", owner: "p1", island: "i1" });
  taken11(w, "c20", "p1", ["p3"]);
  city11(w, { id: "c30", owner: "p2", island: "i2" });
  city11(w, { id: "c31", owner: "p2", island: "i3" });
  for (const p of ["p3", "p4", "p5", "p6"] as const) {
    city11(w, { id: CityIdSchema.parse(`c4${p.slice(1)}`), owner: p, island: "i4" });
  }
  return w;
}

const GARRISON = { settler: 1, peltast: 3 };

function readOf(match: ReturnType<typeof load11>): PRead11 {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a 1.1.0 match reads with 1.1.0's types
  return match.read() as unknown as PRead11;
}

describe("domination by conquest", () => {
  test("a bloc with the cities but one taken city waits; the second conquest starts its countdown", () => {
    const w = baseWorld();
    besiege11(w, {
      city: "c30",
      by: "p1",
      garrison: [{ home: "c1", units: GARRISON }],
      endsAt: T + 100,
    });
    const match = load11(w, O);
    // 6 cities, 1 taken: no countdown.
    expect(testStep(match, () => undefined).map((e) => e.type)).toEqual([]);
    const { events } = match.advanceTo(T + 100);
    expect(events.map((e) => e.type)).toEqual(["city_conquered", "domination_started"]);
    expect(ofType(events, "domination_started")[0]?.data).toEqual({
      key: "p1",
      members: ["p1"],
      cities: 7,
      taken: 2,
      threshold: 6,
      needTaken: 2,
      endsAt: T + 100 + 86400,
    });
    const x = extOf11(match);
    expect(x.conquests).toEqual({
      c20: { by: "p1", former: ["p3"] },
      c30: { by: "p1", former: ["p2"] },
    });
    expect(countdownsQualifyProblems(readOf(match))).toEqual([]);
  });

  test("losing a taken city cancels the countdown (condition); a former owner's recapture is not taken", () => {
    const w = baseWorld();
    city11(w, { id: "c21", owner: "p1", island: "i2" });
    taken11(w, "c21", "p1", ["p4"]);
    countdown11(w, { bloc: "p1", members: ["p1"], endsAt: T + 5000 });
    // p3 retakes c20, which p1 had taken from it.
    besiege11(w, {
      city: "c20",
      by: "p3",
      garrison: [{ home: "c43", units: GARRISON }],
      endsAt: T + 100,
    });
    const match = load11(w, O);
    const { events } = match.advanceTo(T + 100);
    expect(events.map((e) => [e.type, e.data["reason"] ?? null])).toEqual([
      ["city_conquered", null],
      ["domination_cancelled", "condition"],
    ]);
    const x = extOf11(match);
    // p1 still has 7 cities but only c21 is taken; p3 owned c20 before, so it is not taken.
    expect(x.conquests["c20"]).toEqual({ by: "p3", former: ["p1", "p3"] });
    expect(isTaken(x, "c20", "p3")).toBe(false);
    expect(isTaken(x, "c21", "p1")).toBe(true);
    expect(x.domination.countdowns).toEqual([]);
  });

  test("a conquest in the second a countdown ends is resolved first (class 9 before 11)", () => {
    const setup = (siege: boolean) => {
      const w = baseWorld();
      city11(w, { id: "c21", owner: "p1", island: "i2" });
      taken11(w, "c21", "p1", ["p4"]);
      countdown11(w, { bloc: "p1", members: ["p1"], endsAt: T + 500 });
      if (siege) {
        besiege11(w, {
          city: "c21",
          by: "p4",
          garrison: [{ home: "c44", units: GARRISON }],
          endsAt: T + 500,
        });
      }
      return load11(w, O);
    };
    const won = setup(false);
    won.advanceTo(T + 500);
    expect(won.result).toMatchObject({ reason: "domination", winners: ["p1"], endedAt: T + 500 });
    const saved = setup(true);
    const { events } = saved.advanceTo(T + 500);
    expect(events.map((e) => [e.type, e.data["reason"] ?? null])).toEqual([
      ["city_conquered", null],
      ["domination_cancelled", "condition"],
    ]);
    expect(saved.ended).toBe(false);
  });

  test("Olympus taken from no owner is taken; its first owner has no former owner", () => {
    const w = baseWorld();
    city11(w, { id: "c7", owner: null, island: "i3", tag: "olympus" });
    besiege11(w, {
      city: "c7",
      by: "p1",
      garrison: [{ home: "c1", units: GARRISON }],
      endsAt: T + 100,
    });
    const match = load11(w, O);
    const { events } = match.advanceTo(T + 100);
    expect(ofType(events, "domination_started")[0]?.data).toMatchObject({ cities: 7, taken: 2 });
    expect(extOf11(match).conquests["c7"]).toEqual({ by: "p1", former: [] });
  });

  test("a member joining with taken cities cancels the countdown (membership); the new bloc restarts", () => {
    const w = baseWorld();
    city11(w, { id: "c21", owner: "p1", island: "i2" });
    taken11(w, "c21", "p1", ["p4"]);
    addAlliance(w.state, "North", ["p1", "p2"]);
    countdown11(w, { bloc: "a1", members: ["p1", "p2"], endsAt: T + 5000 });
    // p3 holds a city it took from p5.
    city11(w, { id: "c22", owner: "p3", island: "i3" });
    taken11(w, "c22", "p3", ["p5"]);
    const match = load11(w, O);
    const events = testStep(match, (ctx) => {
      const a1 = ctx.state.alliances["a1"];
      const p3 = ctx.state.players["p3"];
      if (a1 === undefined || p3 === undefined) throw new Error("fixture");
      a1.members = ["p1", "p2", "p3"];
      p3.alliance = "a1";
    });
    expect(events.map((e) => [e.type, e.data["reason"] ?? null])).toEqual([
      ["domination_cancelled", "membership"],
      ["domination_started", null],
    ]);
    // 7 + 2 + 2 cities; c20, c21 (p1) and c22 (p3) taken.
    expect(ofType(events, "domination_started")[0]?.data).toMatchObject({
      key: "a1",
      members: ["p1", "p2", "p3"],
      cities: 11,
      taken: 3,
    });
  });

  test("a bloc short of taken cities starts its countdown when an ally with one joins", () => {
    const w = baseWorld();
    addAlliance(w.state, "North", ["p1", "p2"]);
    city11(w, { id: "c22", owner: "p3", island: "i3" });
    taken11(w, "c22", "p3", ["p5"]);
    const match = load11(w, O);
    expect(testStep(match, () => undefined)).toEqual([]);
    const events = testStep(match, (ctx) => {
      const a1 = ctx.state.alliances["a1"];
      const p3 = ctx.state.players["p3"];
      if (a1 === undefined || p3 === undefined) throw new Error("fixture");
      a1.members = ["p1", "p2", "p3"];
      p3.alliance = "a1";
    });
    expect(ofType(events, "domination_started")[0]?.data).toMatchObject({ key: "a1", taken: 2 });
  });

  test("a member leaving with the taken cities cancels the countdown (membership)", () => {
    const w = baseWorld();
    city11(w, { id: "c21", owner: "p1", island: "i2" });
    taken11(w, "c21", "p1", ["p4"]);
    addAlliance(w.state, "North", ["p1", "p2"]);
    countdown11(w, { bloc: "a1", members: ["p1", "p2"], endsAt: T + 5000 });
    const match = load11(w, O);
    const events = testStep(match, (ctx) => leaveAlliance(ctx, "p2", "left"));
    // a1 is dissolved; p1 alone still qualifies (7 cities, 2 taken) and starts its own countdown.
    expect(events.map((e) => [e.type, e.data["key"] ?? null, e.data["reason"] ?? null])).toEqual([
      ["alliance_left", null, null],
      ["alliance_dissolved", null, null],
      ["domination_cancelled", "a1", "membership"],
      ["domination_started", "p1", null],
    ]);
  });

  test("the threshold is fixed: another player's founding never cancels a countdown", () => {
    // pm 150: ceil(150 × 40 / 1000) = 6 cities; it counts slots, not the cities that exist.
    const over = { ...O, "victory.dominationPm": 150 };
    const w = world11({ now: T, overrides: over });
    cities11(w, "p1", 1, 4);
    for (const [id, from] of [
      ["c20", "p3"],
      ["c21", "p4"],
    ] as const) {
      city11(w, { id, owner: "p1", island: "i1" });
      taken11(w, id, "p1", [from]);
    }
    for (const p of ["p2", "p3", "p4", "p5", "p6"] as const) {
      city11(w, { id: CityIdSchema.parse(`c4${p.slice(1)}`), owner: p, island: "i4" });
    }
    countdown11(w, { bloc: "p1", members: ["p1"], endsAt: T + 5000 });
    const match = load11(w, over);
    const events = testStep(match, (ctx) => {
      for (let i = 0; i < 4; i += 1) foundCity(ctx, "i3", "p2", {}, null);
    });
    expect(ofType(events, "domination_cancelled")).toEqual([]);
    expect(extOf11(match).domination.countdowns.map((c) => c.bloc)).toEqual(["p1"]);
  });

  test("countdownsQualifyProblems names a staged countdown whose bloc does not qualify", () => {
    const w = baseWorld();
    countdown11(w, { bloc: "p2", members: ["p2"], endsAt: T + 5000 });
    const match = load11(w, O);
    expect(countdownsQualifyProblems(readOf(match))).toEqual([
      "countdown of p2: 2 cities (0 taken), the threshold is 6 (2 taken)",
    ]);
    // The next step cancels it.
    const events = testStep(match, () => undefined);
    expect(ofType(events, "domination_cancelled")[0]?.data).toMatchObject({
      key: "p2",
      reason: "condition",
    });
    expect(countdownsQualifyProblems(readOf(match))).toEqual([]);
  });

  test("with dominationMinConquests 0, the cities alone qualify", () => {
    const over = { ...O, "victory.dominationMinConquests": 0 };
    const w = world11({ now: T, overrides: over });
    cities11(w, "p1", 1, 6);
    for (const p of ["p2", "p3", "p4", "p5", "p6"] as const) {
      city11(w, { id: CityIdSchema.parse(`c4${p.slice(1)}`), owner: p, island: "i4" });
    }
    const match = load11(w, over);
    const events = testStep(match, () => undefined);
    expect(ofType(events, "domination_started")[0]?.data).toMatchObject({
      cities: 6,
      taken: 0,
      needTaken: 0,
    });
  });
});

/** p1: c1 (acropolis 3) and c7, the Olympus city; p2: c2, taken from p3; p3: c3. */
function scoreWorld(): World11 {
  const w = world11({ now: T, overrides: O });
  city11(w, { id: "c1", owner: "p1", island: "i1", buildings: { acropolis: 3 } });
  city11(w, { id: "c7", owner: "p1", island: "i2", tag: "olympus" });
  city11(w, { id: "c2", owner: "p2", island: "i3" });
  taken11(w, "c2", "p2", ["p3"]);
  city11(w, { id: "c3", owner: "p3", island: "i4" });
  for (const p of ["p4", "p5", "p6"] as const) {
    city11(w, { id: CityIdSchema.parse(`c4${p.slice(1)}`), owner: p, island: "i4" });
  }
  return w;
}

describe("score, standings and the end of the match", () => {
  test("city points: 100 + levels + 100 on Olympus; a taken city scores like any other", () => {
    const plain = load11(scoreWorld(), O);
    const rows = (m: typeof plain) =>
      m.ruleset.hooks.standings(m.read()).map((s) => [s.player, s.score]);
    expect(rows(plain).slice(0, 3)).toEqual([
      ["p1", 303],
      ["p2", 100],
      ["p3", 100],
    ]);
  });

  test("the time victory ranks by 1.1.0's score, Olympus included", () => {
    const match = load11(scoreWorld(), O);
    match.advanceTo(604800);
    // p1's 303 (c1 with acropolis 3, Olympus 200) beats every one-city player.
    expect(match.result).toMatchObject({ reason: "time", winners: ["p1"] });
  });

  test("an eliminated player's frozen score is its last city's 1.1.0 points", () => {
    const w = scoreWorld();
    besiege11(w, {
      city: "c2",
      by: "p1",
      garrison: [{ home: "c1", units: GARRISON }],
      endsAt: T + 100,
    });
    const match = load11(w, O);
    match.advanceTo(T + 100);
    const x = extOf11(match);
    expect(x.frozenScores).toEqual({ p2: { cityPoints: 100, battleScore: 0 } });
    expect(x.conquests["c2"]).toEqual({ by: "p1", former: ["p2", "p3"] });
    const standing = match.ruleset.hooks.standings(match.read()).find((s) => s.player === "p2");
    expect(standing).toMatchObject({ score: 100, alive: false, cities: 0 });
  });

  test("the last player standing wins at once", () => {
    const w = world11({ now: T, overrides: O });
    city11(w, { id: "c1", owner: "p1", island: "i1" });
    city11(w, { id: "c2", owner: "p2", island: "i2" });
    for (const p of ["p3", "p4", "p5", "p6"] as const) {
      const player = w.state.players[p];
      if (player === undefined) throw new Error("fixture");
      player.alive = false;
      player.eliminatedAt = T - 1000;
      w.ext.frozenScores[p] = { cityPoints: 100, battleScore: 0 };
    }
    besiege11(w, {
      city: "c2",
      by: "p1",
      garrison: [{ home: "c1", units: GARRISON }],
      endsAt: T + 100,
    });
    const match = load11(w, O);
    match.advanceTo(T + 100);
    expect(match.result).toMatchObject({ reason: "last_standing", winners: ["p1"] });
    expect(extOf11(match).conquests["c2"]).toEqual({ by: "p1", former: ["p2"] });
  });
});
