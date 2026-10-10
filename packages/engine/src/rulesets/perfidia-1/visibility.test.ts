import { describe, expect, test } from "bun:test";
import type { Visibility } from "@perfidia/engine/contracts";
import { addAlliance, addMovement } from "@perfidia/engine/testing";
import { compareIds, type PlayerId } from "@perfidia/protocol";
import { besiege, city, countdown, load, world } from "./fixtures.test.ts";

// Fog of war (perfidia-1 §12, docs/architecture.md §8.1–8.2): the public extras and the briefing
// hook, built from public data only; raw battle points never leave the engine.

const T = 300000;
const PLAYERS: readonly PlayerId[] = ["p1", "p2", "p3", "p4", "p5", "p6"];

function setting() {
  const w = world({ now: T });
  const start = { hall: 1, lumber: 1, quarry: 1, mine: 1, warehouse: 1 };
  city(w, { id: "c1", owner: "p1", island: "i1", capital: true, buildings: start });
  city(w, { id: "c2", owner: "p2", island: "i2", capital: true, buildings: start });
  for (const p of ["p3", "p4", "p5", "p6"] as const) {
    city(w, { id: `c${Number(p.slice(1))}`, owner: p, island: "i3", buildings: start });
  }
  const crown = Object.fromEntries(
    ["hall", "lumber", "quarry", "mine", "warehouse", "barracks", "harbor", "wall"].map((b) => [
      b,
      5,
    ]),
  );
  city(w, { id: "c7", owner: null, island: "i4", tag: "crown", buildings: crown });
  besiege(w, {
    city: "c1",
    by: "p2",
    garrison: [{ home: "c2", units: { settler: 1, raider: 4 } }],
    startedAt: T - 600,
  });
  addAlliance(w.state, "South", ["p3", "p4"]);
  countdown(w, { bloc: "a1", members: ["p3", "p4"], startedAt: T - 100 });
  w.ext.battlePoints["p1"] = 987654;
  w.ext.battlePoints["p2"] = 123457;
  return w;
}

function visibility(): Visibility<unknown, unknown> {
  const v = load(setting()).ruleset.hooks.visibility;
  if (
    v?.publicCity === undefined ||
    v.publicPlayer === undefined ||
    v.publicMatch === undefined ||
    v.briefing === undefined ||
    v.cityAccess === undefined ||
    v.movementAccess === undefined
  ) {
    throw new Error("perfidia-1 defines every visibility hook");
  }
  return {
    cityAccess: v.cityAccess,
    movementAccess: v.movementAccess,
    publicCity: v.publicCity,
    publicPlayer: v.publicPlayer,
    publicMatch: v.publicMatch,
    briefing: v.briefing,
  };
}

describe("public extras", () => {
  test("publicCity shows a city's points, the Crown and a besieged city's siege end", () => {
    const match = load(setting());
    const v = visibility();
    const r = match.read();
    const ends = T - 600 + 21600;
    expect(v.publicCity(r, "p5", "c1")).toEqual({
      points: 105,
      siege: { by: "p2", ends: [ends, "D4 17:10"] },
    });
    expect(v.publicCity(r, "p1", "c2")).toEqual({ points: 105 });
    expect(v.publicCity(r, "p1", "c7")).toEqual({ points: 240, crown: true });
  });

  test("publicMatch shows the tie-break order and the countdowns against the threshold", () => {
    const match = load(setting());
    expect(visibility().publicMatch(match.read())).toEqual({
      tiebreak: [...PLAYERS],
      domination: {
        open: true,
        need: 12,
        countdowns: [
          {
            key: "a1",
            members: ["p3", "p4"],
            cities: 2,
            need: 12,
            ends: [T - 100 + 86400, "D5 11:18:20"],
          },
        ],
      },
    });
    expect(visibility().publicPlayer(match.read(), "p4")).toEqual({ tiebreak: 4 });
  });

  test("the briefing hook lists the sieges the seat holds and every running countdown", () => {
    const match = load(setting());
    const v = visibility();
    const r = match.read();
    const p2 = v.briefing?.(r, "p2");
    expect(p2).toEqual({
      holding: [{ city: "c1", owner: "p1", ends: [T - 600 + 21600, "D4 17:10"] }],
      countdowns: [
        {
          key: "a1",
          members: ["p3", "p4"],
          cities: 2,
          need: 12,
          ends: [T - 100 + 86400, "D5 11:18:20"],
        },
      ],
    });
    expect(v.briefing?.(r, "p1")).toMatchObject({ holding: [] });
  });

  test("standings and every view show the capped battle score, never raw battle points", () => {
    const match = load(setting());
    const v = visibility();
    const r = match.read();
    const standings = match.ruleset.hooks.standings(r);
    for (const s of standings)
      expect(Object.keys(s.parts).toSorted(compareIds)).toEqual(["battleScore", "cityPoints"]);
    // p1: min(floor(987654 / 10), floor(105 / 4)) = 26.
    expect(standings.find((s) => s.player === "p1")?.parts).toEqual({
      cityPoints: 105,
      battleScore: 26,
    });
    const shown = JSON.stringify([
      standings,
      PLAYERS.map((p) => v.publicPlayer(r, p)),
      PLAYERS.map((p) => v.briefing?.(r, p)),
      ["c1", "c2", "c3", "c7"].map((c) => v.publicCity(r, "p3", `c${Number(c.slice(1))}`)),
      v.publicMatch(r),
    ]);
    for (const secret of ["987654", "123457", "battlePoints"]) expect(shown).not.toContain(secret);
  });
});

describe("access", () => {
  test("allies see cities in full; the besieger sees a homecoming without composition", () => {
    const w = setting();
    const back = addMovement(w.state, w.rules, {
      kind: "return",
      owner: "p1",
      from: "c3",
      home: "c1",
      to: "c1",
      units: { raider: 2 },
      departAt: T - 100,
      arriveAt: T + 5000,
    });
    const match = load(w);
    const v = visibility();
    const r = match.read();
    expect(v.cityAccess(r, "p4", "c3")).toBe("full");
    expect(v.cityAccess(r, "p2", "c1")).toBe("public");
    expect(v.movementAccess(r, "p2", back.id)).toBe("incoming");
    expect(v.movementAccess(r, "p1", back.id)).toBe("own");
    expect(v.movementAccess(r, "p5", back.id)).toBeNull();
  });
});
