import { describe, expect, test } from "bun:test";
import { endPact, leaveAlliance } from "@perfidia/engine/std";
import { addAlliance, addMovement, addPact, testStep } from "@perfidia/engine/testing";
import { CityIdSchema, type CityId, type PlayerId } from "@perfidia/protocol";
import {
  besiege,
  city,
  copyFor,
  countdown,
  extOf,
  load,
  ofType,
  type World,
  world,
} from "./fixtures.test.ts";

// Victory (perfidia-1 §13.3), domination countdowns, relation history and the kill-credit cooldown
// (§8.8), and betrayal on impact (§8.9), through the kernel.

const T = 300000;

/** `n` cities of `owner` with ids from `first`, spread over the four test islands. */
function cities(w: World, owner: PlayerId, first: number, n: number, levels = 0): CityId[] {
  const ids: CityId[] = [];
  for (let i = 0; i < n; i += 1) {
    const id: CityId = `c${first + i}`;
    city(w, { id, owner, island: `i${1 + (i % 4)}`, buildings: { hall: levels } });
    ids.push(id);
  }
  return ids;
}

function endEvents(w: { state: { queue: readonly { kind: string; ref: string }[] } }) {
  return w.state.queue.filter((e) => e.kind === "domination_end").map((e) => e.ref);
}

function allianceWorld(): World {
  const w = world({ now: T });
  cities(w, "p1", 1, 8);
  cities(w, "p2", 20, 4);
  for (const p of ["p3", "p4", "p5", "p6"] as const) cities(w, p, 30 + Number(p.slice(1)), 1);
  addAlliance(w.state, "North", ["p1", "p2"]);
  countdown(w, { bloc: "a1", members: ["p1", "p2"], startedAt: T - 1000 });
  return w;
}

describe("domination countdowns", () => {
  test("the domination_open timer opens evaluation and starts a qualifying bloc at that step", () => {
    const w = world({ now: 259200 - 100 });
    cities(w, "p1", 1, 12);
    for (const p of ["p2", "p3", "p4", "p5", "p6"] as const)
      cities(w, p, 20 + Number(p.slice(1)), 1);
    const match = load(w);
    match.advanceTo(259200 - 1);
    expect(extOf(match).domination).toEqual({ open: false, countdowns: [] });
    const { events } = match.advanceTo(259200);
    const x = extOf(match);
    expect(x.domination.open).toBe(true);
    expect(x.domination.countdowns).toEqual([
      {
        bloc: "p1",
        members: ["p1"],
        startedAt: 259200,
        endsAt: 259200 + 86400,
        seq: x.domination.countdowns[0]?.seq ?? -1,
      },
    ]);
    expect(ofType(events, "domination_started")).toEqual([
      {
        t: 259200,
        type: "domination_started",
        public: true,
        to: [],
        data: { key: "p1", members: ["p1"], cities: 12, threshold: 12, endsAt: 345600 },
      },
    ]);
  });

  test("a founding that makes a bloc qualify starts a countdown at that step", () => {
    const w = world({ now: T });
    cities(w, "p1", 1, 11);
    for (const p of ["p2", "p3", "p4", "p5", "p6"] as const)
      cities(w, p, 20 + Number(p.slice(1)), 1);
    addMovement(w.state, w.rules, {
      kind: "found",
      owner: "p1",
      from: "c1",
      to: null,
      toIsland: "i4",
      units: { settler: 1, guard: 5 },
      departAt: T - 3600,
      arriveAt: T + 1,
    });
    const match = load(w);
    match.advanceTo(T);
    expect(extOf(match).domination.countdowns).toEqual([]);
    const { events } = match.advanceTo(T + 1);
    expect(events.map((e) => e.type)).toEqual(["city_founded", "domination_started"]);
    const founded = ofType(events, "city_founded")[0]?.data;
    expect(founded).toMatchObject({ island: "i4", owner: "p1" });
    const id = CityIdSchema.parse(founded?.["city"]);
    expect(match.read().state.cities[id]?.units).toEqual({ guard: 5 });
    expect(ofType(events, "domination_started")[0]?.data).toMatchObject({
      key: "p1",
      cities: 12,
      threshold: 12,
      endsAt: T + 1 + 86400,
    });
  });

  test("a membership change applied with testStep cancels it; a qualifying new bloc restarts", () => {
    const w = allianceWorld();
    const match = load(w);
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
    const x = extOf(match);
    expect(x.domination.countdowns).toMatchObject([
      { bloc: "a1", members: ["p1", "p2", "p3"], startedAt: T, endsAt: T + 86400 },
    ]);
    const queued = match.read().state.queue.filter((e) => e.kind === "domination_end");
    expect(queued.map((e) => [e.ref, e.at])).toEqual([["a1", T + 86400]]);
  });

  test("a member leaving dissolves the bloc and cancels its countdown", () => {
    const match = load(allianceWorld());
    const events = testStep(match, (ctx) => leaveAlliance(ctx, "p2", "left"));
    expect(ofType(events, "domination_cancelled")[0]?.data).toEqual({
      key: "a1",
      members: ["p1", "p2"],
      reason: "membership",
    });
    expect(ofType(events, "domination_started")).toEqual([]);
    expect(extOf(match).domination.countdowns).toEqual([]);
    expect(endEvents({ state: match.read().state })).toEqual([]);
  });

  test("a conquest that drops the bloc below the threshold cancels it (condition)", () => {
    const w = allianceWorld();
    cities(w, "p6", 40, 1);
    besiege(w, {
      city: "c1",
      by: "p6",
      garrison: [{ home: "c40", units: { settler: 1 } }],
      endsAt: T + 100,
    });
    const match = load(w);
    const { events } = match.advanceTo(T + 100);
    expect(events.map((e) => e.type)).toEqual(["city_conquered", "domination_cancelled"]);
    expect(ofType(events, "domination_cancelled")[0]?.data).toMatchObject({ reason: "condition" });
  });

  test("a countdown that runs out while the bloc still qualifies wins the match", () => {
    const match = load(allianceWorld());
    const ends = extOf(match).domination.countdowns[0]?.endsAt ?? 0;
    const { events } = match.advanceTo(ends);
    expect(match.ended).toBe(true);
    expect(match.result).toMatchObject({
      endedAt: ends,
      reason: "domination",
      winners: ["p1", "p2"],
    });
    expect(match.result?.standings.slice(0, 2).map((s) => s.player)).toEqual(["p1", "p2"]);
    expect(events.map((e) => e.type)).toEqual(["match_ended"]);
  });

  // a1 = {p1, p2} against a2 = {p3, p4}: [cities, building levels per city] of each, and the
  // public tie-break order (default p1..p6, where a1 holds the best position).
  const SAME_SECOND: readonly {
    why: string;
    a1: readonly [number, number];
    a2: readonly [number, number];
    tiebreak?: readonly PlayerId[];
    winners: readonly PlayerId[];
  }[] = [
    { why: "more cities", a1: [13, 0], a2: [14, 0], winners: ["p3", "p4"] },
    { why: "a higher total score", a1: [13, 0], a2: [13, 1], winners: ["p3", "p4"] },
    {
      why: "the best tie-break position (a2's)",
      a1: [13, 0],
      a2: [13, 0],
      tiebreak: ["p5", "p4", "p1", "p2", "p3", "p6"],
      winners: ["p3", "p4"],
    },
    { why: "the best tie-break position (a1's)", a1: [13, 0], a2: [13, 0], winners: ["p1", "p2"] },
  ];

  for (const c of SAME_SECOND) {
    test(`countdowns ending in the same second resolve together: ${c.why} wins`, () => {
      const w = world({ now: T });
      cities(w, "p1", 1, c.a1[0] - 1, c.a1[1]);
      cities(w, "p2", 20, 1, c.a1[1]);
      cities(w, "p3", 30, c.a2[0] - 1, c.a2[1]);
      cities(w, "p4", 50, 1, c.a2[1]);
      cities(w, "p5", 60, 1);
      cities(w, "p6", 61, 1);
      if (c.tiebreak !== undefined) w.ext.tiebreak = [...c.tiebreak];
      addAlliance(w.state, "North", ["p1", "p2"]);
      addAlliance(w.state, "South", ["p3", "p4"]);
      // a1's event is queued first, so it pops first, and a1 has the smaller bloc id: the order
      // must depend on neither.
      countdown(w, { bloc: "a1", members: ["p1", "p2"], endsAt: T + 1000 });
      countdown(w, { bloc: "a2", members: ["p3", "p4"], endsAt: T + 1000 });
      const match = load(w);
      match.advanceTo(T + 1000);
      expect(match.result).toMatchObject({
        endedAt: T + 1000,
        reason: "domination",
        winners: [...c.winners],
      });
    });
  }

  test("blocs qualifying in the same step start in bloc order: alliances, then lone players", () => {
    const w = world({ now: 259200 - 100 });
    // p1 alone has more cities and the smallest member id; the alliance a1 still starts first.
    cities(w, "p1", 1, 14);
    cities(w, "p3", 20, 11);
    cities(w, "p4", 40, 1);
    for (const p of ["p2", "p5", "p6"] as const) cities(w, p, 50 + Number(p.slice(1)), 1);
    addAlliance(w.state, "South", ["p3", "p4"]);
    const match = load(w);
    const { events } = match.advanceTo(259200);
    // 29 cities: the threshold is max(2·6, ceilDiv(400·29, 1000)) = 12.
    expect(ofType(events, "domination_started").map((e) => e.data)).toEqual([
      { key: "a1", members: ["p3", "p4"], cities: 12, threshold: 12, endsAt: 345600 },
      { key: "p1", members: ["p1"], cities: 14, threshold: 12, endsAt: 345600 },
    ]);
    expect(extOf(match).domination.countdowns.map((c) => c.bloc)).toEqual(["a1", "p1"]);
  });
});

describe("time victory (§13.3)", () => {
  test("at matchEnd the highest score wins, alone even inside an alliance", () => {
    const w = world({ now: 604800 - 10 });
    cities(w, "p1", 1, 2);
    cities(w, "p2", 10, 3);
    cities(w, "p3", 20, 1);
    addAlliance(w.state, "North", ["p1", "p2"]);
    const match = load(w);
    match.advanceTo(604800);
    expect(match.result).toMatchObject({ endedAt: 604800, reason: "time", winners: ["p2"] });
    expect(match.result?.standings.map((s) => [s.player, s.rank, s.cities])).toEqual([
      ["p2", 1, 3],
      ["p1", 2, 2],
      ["p3", 3, 1],
      ["p4", 4, 0],
      ["p5", 5, 0],
      ["p6", 6, 0],
    ]);
  });
});

function battleBetween(o: { readonly endedAgo: number | null; readonly pact?: boolean }) {
  const w = world({ now: T });
  city(w, { id: "c1", owner: "p1", island: "i1" });
  city(w, { id: "c2", owner: "p2", island: "i2", units: { guard: 5 } });
  if (o.endedAgo !== null) w.ext.relationEnds["p1|p2"] = T + 1 - o.endedAgo;
  if (o.pact === true) addPact(w.state, w.rules, "p1", "p2", { expiresAt: T + 9000 });
  addMovement(w.state, w.rules, {
    kind: "attack",
    owner: "p1",
    from: "c1",
    to: "c2",
    units: { raider: 40 },
    party: "p2",
    departAt: T - 3599,
    arriveAt: T + 1,
  });
  const match = load(w);
  const { events } = match.advanceTo(T + 1);
  const x = extOf(match);
  return { events, points: [x.battlePoints["p1"], x.battlePoints["p2"]] };
}

describe("relation history and the kill-credit cooldown (§8.8)", () => {
  test("afterStep records when a pair stops being related", () => {
    const w = world({ now: T });
    cities(w, "p1", 1, 1);
    cities(w, "p2", 2, 1);
    addPact(w.state, w.rules, "p1", "p2", { expiresAt: T + 9000 });
    const match = load(w);
    testStep(match, () => undefined);
    expect(extOf(match).related).toEqual(["p1|p2"]);
    testStep(match, (ctx) => endPact(ctx, "p1", "p2", "left"));
    const x = extOf(match);
    expect(x.related).toEqual([]);
    expect(x.relationEnds).toEqual({ "p1|p2": T });
  });

  test("no credit between players related less than 86400 s ago, credit from then on", () => {
    expect(battleBetween({ endedAgo: null }).points).toEqual([5, 1]);
    expect(battleBetween({ endedAgo: 86400 }).points).toEqual([5, 1]);
    expect(battleBetween({ endedAgo: 86399 }).points).toEqual([0, 0]);
  });

  test("betrayal ends the pact on impact only, with a public event and no credit", () => {
    const { events, points } = battleBetween({ endedAgo: null, pact: true });
    expect(points).toEqual([0, 0]);
    expect(events.map((e) => e.type).slice(-2)).toEqual(["pact_ended", "betrayal"]);
    expect(ofType(events, "pact_ended")[0]?.data).toMatchObject({ cause: "betrayal" });
    expect(ofType(events, "betrayal")[0]).toMatchObject({
      public: true,
      to: [
        { p: "p1", as: "self" },
        { p: "p2", as: "target" },
      ],
      data: { by: "p1", against: "p2", relation: "pact", city: "c2" },
    });
  });

  test("an attack on an ally is launched as usual and leaves the alliance on impact", () => {
    const w = world({ now: T });
    city(w, { id: "c1", owner: "p1", island: "i1", units: { raider: 40 } });
    city(w, { id: "c2", owner: "p2", island: "i2", units: { guard: 5 } });
    addAlliance(w.state, "North", ["p1", "p2"]);
    const match = load(w);
    const out = match.apply("p1", { type: "attack", from: "c1", to: "c2", units: { raider: 40 } });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(copyFor(out.events, "incoming_attack", "p2").data).toMatchObject({ foe: "p2" });
    expect(match.read().state.players["p1"]?.alliance).toBe("a1");
    const arrival = match.nextEventTime() ?? 0;
    match.advanceTo(arrival - 1);
    expect(match.read().state.alliances["a1"]?.members).toEqual(["p1", "p2"]);
    const { events } = match.advanceTo(arrival);
    expect(match.read().state.alliances).toEqual({});
    expect(events.map((e) => e.type).slice(-3)).toEqual([
      "alliance_left",
      "alliance_dissolved",
      "betrayal",
    ]);
    expect(ofType(events, "betrayal")[0]?.data).toEqual({
      by: "p1",
      against: "p2",
      relation: "ally",
      city: "c2",
    });
    expect(extOf(match).relationEnds).toEqual({ "p1|p2": arrival });
  });
});
