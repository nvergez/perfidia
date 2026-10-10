import { describe, expect, test } from "bun:test";
import type { AnyRuleset } from "@perfidia/engine/contracts";
import { defaultVisibility } from "@perfidia/engine/std";
import { matchFromState } from "@perfidia/engine/testing";
import { fixtureRuleset } from "@perfidia/engine/testing";
import {
  CityViewSchema,
  GameStateSchema,
  IslandViewSchema,
  LeaderboardViewSchema,
  MapViewSchema,
  PlayerViewSchema,
  type CityViewFull,
  type CityViewPublic,
  type GameState,
  type MovementView,
} from "@perfidia/protocol";
import type { Match } from "@perfidia/engine/kernel";
import type { GatewayState } from "@perfidia/gateway/seat";
import {
  buildBriefing,
  leaderboard,
  rulesInfo,
  viewCity,
  viewIsland,
  viewMap,
  viewPlayer,
} from "./index.ts";
import {
  NOW,
  P1,
  P2,
  P3,
  P4,
  deepFreeze,
  feedP1,
  fixtureMatch,
  fixtureWorld,
  gatewayFor,
  grantingRuleset,
  scribble,
  text,
  wakeRecord,
} from "./testkit.test.ts";

const SEATS = [P1, P2, P3, P4] as const;
const CITIES = ["c1", "c2", "c3", "c4", "c5", "c6", "c99"];

function world(ruleset: AnyRuleset = fixtureRuleset): { match: Match; gw: GatewayState } {
  const match = fixtureMatch([], ruleset);
  const { gw, wake } = gatewayFor(match);
  feedP1(gw, wake, match.read());
  return { match, gw };
}

/** Any value, typed loosely so that `toEqual` compares it with plain values. */
function loose(value: unknown): unknown {
  return value;
}

function full(view: ReturnType<typeof viewCity>): CityViewFull {
  const parsed = CityViewSchema.parse(view);
  if (parsed.access !== "full") throw new Error(`expected a full view, got ${parsed.access}`);
  return parsed;
}

function publicView(view: ReturnType<typeof viewCity>): CityViewPublic {
  const parsed = CityViewSchema.parse(view);
  if (parsed.access !== "public") throw new Error(`expected a public view, got ${parsed.access}`);
  return parsed;
}

function outgoingOf(view: CityViewFull): MovementView[] {
  const out = view["outgoing"];
  if (!Array.isArray(out)) throw new Error("no outgoing list");
  return out.map((m: unknown) => {
    const parsed = CityViewSchema.parse({ ...view, incoming: [m] });
    if (parsed.access !== "full") throw new Error("unreachable");
    const [first] = parsed.incoming;
    if (first === undefined) throw new Error("unreachable");
    return first;
  });
}

/** Every view of every seat, as canonical JSON. */
function everything(match: Match, gw: GatewayState): string {
  const r = match.read();
  return text(
    SEATS.map((seat) => ({
      cities: CITIES.map((c) => viewCity(r, seat, c, gw)),
      islands: ["i1", "i2", "i9"].map((i) => viewIsland(r, seat, i)),
      maps: [viewMap(r, seat), viewMap(r, seat, "c1"), viewMap(r, seat, "c6")],
      players: [...SEATS, "p9"].map((p) => viewPlayer(r, seat, p, gw)),
      board: leaderboard(r),
      briefing: buildBriefing(r, seat, gw, wakeRecord(["safety"])),
      rules: rulesInfo(match),
    })),
  );
}

describe("view_city", () => {
  test("an own city in full: stock, rates, cap, pop, buildings, queues, units, incoming", () => {
    const { match, gw } = world();
    const v = full(viewCity(match.read(), P1, "c1", gw));
    expect(v.stock).toEqual({ wood: 300, stone: 300, gold: 300 });
    expect(v.rates).toEqual({ wood: 60, stone: 60, gold: 60 });
    expect(v.cap).toBe(1000);
    // 12 at home + 5 stationed in c5 + 5 queued (pop 1 each).
    expect(v.pop).toEqual({ used: 22, cap: 80 });
    expect(v.buildings).toEqual({
      tower: 2,
      woodcut: 1,
      stonecut: 1,
      goldcut: 1,
      vault: 1,
      drill: 1,
    });
    expect(v.build).toEqual([
      { item: 1, building: "tower", level: 3, start: [7200, "D1 02:00"], end: [9000, "D1 02:30"] },
    ]);
    expect(v.recruit).toEqual({
      drill: [
        {
          item: 2,
          unit: "soldier",
          count: 5,
          done: 0,
          start: [7200, "D1 02:00"],
          end: [7500, "D1 02:05"],
        },
      ],
    });
    expect(v.units).toEqual({ soldier: 12 });
    expect(v.stationed).toEqual([]);
    // p3's attack: origin, owner, recorded foe, launch and arrival, no composition.
    expect(v.incoming).toHaveLength(1);
    const [attack] = v.incoming;
    expect(attack).toMatchObject({
      kind: "attack",
      access: "incoming",
      owner: P3,
      from: "c5",
      to: "c1",
      party: P1,
      depart: [6600, "D1 01:50"],
      arrive: [12000, "D1 03:20"],
    });
    expect(attack).not.toHaveProperty("units");
    expect(attack).not.toHaveProperty("cargo");
    expect(v["outgoing"]).toEqual([]);
  });

  test("a held own city shows the publicCity extra and the foreign hold group", () => {
    const { match, gw } = world();
    const v = full(viewCity(match.read(), P1, "c3", gw));
    expect(v.ext).toEqual({ held: { by: P4, since: [NOW, "D1 02:00"] } });
    expect(v.stationed).toEqual([{ owner: P4, home: "c6", role: "hold", units: { soldier: 4 } }]);
  });

  test("an ally's city in full; its outgoing movements only as movementAccess grants", () => {
    const deny = world();
    const v = full(viewCity(deny.match.read(), P1, "c4", deny.gw));
    // p4's attack on the ally (no composition) and p1's own support (in full).
    expect(v.incoming.map((m) => [m.owner, m.kind, m.access])).toEqual([
      [P4, "attack", "incoming"],
      [P1, "support", "own"],
    ]);
    expect(v.incoming[1]).toMatchObject({
      units: { soldier: 2 },
      home: "c2",
      recallableUntil: [7700, "D1 02:08:20"],
    });
    expect(v.stationed).toEqual([
      { owner: P1, home: "c2", role: "support", units: { soldier: 3 } },
    ]);
    // The default visibility (perfidia-1 §12) never shows an ally's outgoing attack.
    expect(outgoingOf(v)).toEqual([]);

    const grant = world(grantingRuleset);
    const g = full(viewCity(grant.match.read(), P1, "c4", grant.gw));
    const out = outgoingOf(g);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      owner: P2,
      kind: "attack",
      access: "full",
      from: "c4",
      to: "c6",
      units: { soldier: 4 },
    });
  });

  test("the seat's own movements show in full, whatever movementAccess says of them", () => {
    for (const own of [null, "incoming", "full"] as const) {
      const denying: AnyRuleset = {
        ...fixtureRuleset,
        hooks: {
          ...fixtureRuleset.hooks,
          visibility: {
            ...fixtureRuleset.hooks.visibility,
            movementAccess: (r, viewer, m) =>
              r.state.movements[m]?.owner === viewer
                ? own
                : defaultVisibility.movementAccess(r, viewer, m),
          },
        },
      };
      const { match, gw } = world(denying);
      const r = match.read();
      const support = full(viewCity(r, P1, "c4", gw)).incoming.find((m) => m.owner === P1);
      expect(support).toMatchObject({
        kind: "support",
        access: "own",
        units: { soldier: 2 },
        recallableUntil: [7700, "D1 02:08:20"],
      });
      expect(loose(outgoingOf(full(viewCity(r, P1, "c2", gw))))).toEqual([support]);
      expect(loose(viewPlayer(r, P1, P1, gw)?.private?.movements)).toEqual([support]);
    }
  });

  test("another player's city: public fields, extras and the latest intel snapshot", () => {
    const { match, gw } = world();
    const r = match.read();
    const c5 = publicView(viewCity(r, P1, "c5", gw));
    expect(c5).toEqual({
      access: "public",
      id: "c5",
      name: "c5",
      owner: P3,
      island: "i2",
      slot: 2,
      capitalOf: P3,
      tag: null,
      ext: { held: { by: P1, since: [NOW, "D1 02:00"] } },
      intel: null,
    });
    const c6 = publicView(viewCity(r, P1, "c6", gw));
    expect(c6.intel).toMatchObject({
      type: "battle_report",
      at: [6500, "D1 01:48:20"],
      age: [700, "11m40s"],
      data: { city: "c6", winner: "defender", lost: { soldier: 3 } },
    });
    expect(c6).not.toHaveProperty("units");
    // p4 sees no intel on c6 (its own city is full) and none on c1.
    expect(publicView(viewCity(r, P4, "c1", gw)).intel).toBeNull();
  });

  test("an unknown city is null", () => {
    const { match, gw } = world();
    expect(viewCity(match.read(), P1, "c99", gw)).toBeNull();
    expect(viewCity(match.read(), P1, "__proto__", gw)).toBeNull();
  });
});

describe("view_island and view_map", () => {
  test("view_island: occupants, free slots, travel from each own city per probe", () => {
    const { match } = world();
    const v = IslandViewSchema.parse(viewIsland(match.read(), P1, "i2"));
    expect(v).toMatchObject({ id: "i2", kind: "plain", x: 10, y: 0, slots: 4, free: [3] });
    expect(v.cities.map((c) => c.id)).toEqual(["c3", "c4", "c5"]);
    expect(v.probes).toEqual(["any"]);
    expect(v.travel).toEqual([
      { from: "c1", times: [[5400, "1h30m"]] },
      { from: "c2", times: [[5400, "1h30m"]] },
      { from: "c3", times: [[3600, "1h"]] },
    ]);
    expect(viewIsland(match.read(), P1, "i9")).toBeNull();
  });

  test("view_map: every island and city; with fromCity, travel to every island", () => {
    const { match } = world();
    const r = match.read();
    const plain = MapViewSchema.parse(viewMap(r, P1));
    expect(plain.islands.map((i) => [i.id, i.free])).toEqual([
      ["i1", 1],
      ["i2", 1],
    ]);
    expect(plain.cities.map((c) => c.id)).toEqual(["c1", "c2", "c3", "c4", "c5", "c6"]);
    expect(plain.cities.find((c) => c.id === "c3")?.ext).toEqual({
      held: { by: P4, since: [NOW, "D1 02:00"] },
    });
    expect(plain.cities.find((c) => c.id === "c1")).not.toHaveProperty("ext");
    expect(plain).not.toHaveProperty("travel");
    const from = MapViewSchema.parse(viewMap(r, P1, "c6"));
    expect(from.from).toBe("c6");
    expect(from.travel).toEqual({ i1: [[3600, "1h"]], i2: [[5400, "1h30m"]] });
    expect(viewMap(r, P1, "c99")).toBeNull();
  });
});

describe("view_player and leaderboard", () => {
  test("on oneself: movements, stationed groups (a hold garrison included), settler k and cost", () => {
    const { match, gw } = world();
    const v = PlayerViewSchema.parse(viewPlayer(match.read(), P1, P1, gw));
    expect(v).toMatchObject({
      id: P1,
      alive: true,
      alliance: "a1",
      cities: ["c1", "c2", "c3"],
      relation: "self",
      relations: [{ player: P2, kind: "ally", until: null }],
    });
    const priv = v.private;
    if (priv === undefined) throw new Error("no private section");
    expect(priv.movements.map((m) => [m.kind, m.access, m.to])).toEqual([["support", "own", "c4"]]);
    expect(priv.stationed).toEqual([
      { city: "c4", role: "support", home: "c2", units: { soldier: 3 } },
      { city: "c5", role: "hold", home: "c1", units: { soldier: 5 } },
    ]);
    // k = 3 cities; the fixture's settler costs are 100, 200, 300 (clamped to the last).
    expect(priv.settler).toEqual({
      unit: "pioneer",
      k: 3,
      cost: { wood: 300, stone: 300, gold: 300 },
    });
    expect(priv.proposals).toHaveLength(1);
    expect(priv.proposals[0]).toMatchObject({
      from: P3,
      to: P1,
      kind: "pact",
      text: "Peace  for two days?",
    });
    expect(priv.today).toEqual({ day: 0, ownWakes: 0, socialWakes: 0, attacks: 0, messages: 0 });
    expect(priv.selfWakeAt).toBeNull();
  });

  test("on another player: the public profile only", () => {
    const { match, gw } = world();
    const v = PlayerViewSchema.parse(viewPlayer(match.read(), P1, P4, gw));
    expect(v).not.toHaveProperty("private");
    expect(v).toMatchObject({
      id: P4,
      cities: ["c6"],
      score: 103,
      parts: { cityPoints: 100, levelPoints: 3 },
      relation: "none",
      relations: [{ player: P3, kind: "pact", until: [57200, "D1 15:53:20"] }],
    });
    expect(viewPlayer(match.read(), P1, "p9", gw)).toBeNull();
  });

  test("the leaderboard: standings, alliances, relations and publicMatch extras", () => {
    const { match } = world();
    const v = LeaderboardViewSchema.parse(leaderboard(match.read()));
    expect(v.standings.map((s) => [s.rank, s.player, s.score, s.alliance])).toEqual([
      [1, P1, 315, "a1"],
      [2, P3, 104, null],
      [3, P2, 103, "a1"],
      [4, P4, 103, null],
    ]);
    expect(v.standings[0]?.relations).toEqual([{ player: P2, kind: "ally", until: null }]);
    expect(v.ext).toEqual({});
  });
});

describe("purity (P3, gateway part), fresh objects and determinism", () => {
  test("no view, briefing or rules payload changes the state hash", () => {
    const { match, gw } = world();
    const before = match.hash();
    const gwBefore = text(gw);
    everything(match, gw);
    expect(match.hash()).toBe(before);
    expect(text(gw)).toBe(gwBefore);
  });

  test("views read a deep-frozen state without writing", () => {
    const { match, gw } = world();
    const before = match.hash();
    deepFreeze(match.read().state);
    deepFreeze(gw);
    expect(() => everything(match, gw)).not.toThrow();
    expect(match.hash()).toBe(before);
  });

  test("outputs are fresh objects: scribbling over them changes nothing", () => {
    const { match, gw } = world();
    const r = match.read();
    const first = everything(match, gw);
    const hash = match.hash();
    for (const seat of SEATS) {
      for (const c of CITIES) scribble(viewCity(r, seat, c, gw));
      scribble(viewMap(r, seat, "c1"));
      scribble(viewIsland(r, seat, "i1"));
      for (const p of SEATS) scribble(viewPlayer(r, seat, p, gw));
      scribble(buildBriefing(r, seat, gw, wakeRecord(["safety"])));
    }
    scribble(leaderboard(r));
    scribble(rulesInfo(match));
    expect(match.hash()).toBe(hash);
    expect(everything(match, gw)).toBe(first);
  });

  test("the same world gives byte-identical outputs, whatever the record insertion order", () => {
    const a = world();
    const b = world();
    expect(everything(b.match, b.gw)).toBe(everything(a.match, a.gw));
    const reversed = matchFromState(reverseRecords(fixtureWorld()), fixtureRuleset);
    const { gw, wake } = gatewayFor(reversed);
    feedP1(gw, wake, reversed.read());
    expect(reversed.hash()).toBe(a.match.hash());
    expect(everything(reversed, gw)).toBe(everything(a.match, a.gw));
  });
});

/** `v` with every object's keys inserted in reverse order (arrays keep their order). */
function flip(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(flip);
  if (v === null || typeof v !== "object") return v;
  return Object.fromEntries(
    Object.entries(v)
      .toReversed()
      .map(([k, x]) => [k, flip(x)]),
  );
}

function reverseRecords(state: GameState): GameState {
  return GameStateSchema.parse(flip(state));
}
