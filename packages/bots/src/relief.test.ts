// The relief pack (docs/architecture.md §11.2): the relief module (`relief.ts`), own-wake pacing
// (`pace.ts`) and the bots that use them, expander@2, turtle@2 and opportunist@2, on rules shaped
// like perfidia-1 (its hints: the siege and the domination countdowns in the public extras).

import { describe, expect, test } from "bun:test";
import type {
  Briefing,
  CityId,
  IslandId,
  JsonObject,
  PlayerId,
  ToolCall,
} from "@perfidia/protocol";
import {
  callsTo,
  capital,
  counts,
  perfidiaGame,
  playTurn,
  res,
  sandboxGame,
  str,
  type FakeGame,
  type FCity,
} from "./fixtures.test.ts";
import { fmtTime } from "./kit.ts";
import { parseMemory } from "./memory.ts";
import { createBotVersion } from "./registry.ts";
import { streamOf } from "./rng.ts";
import { opportunist2Params } from "./strategies/opportunist2.ts";
import type { BotStrategy } from "./strategies/strategy.ts";

const DAY = 86400;
const pair = (t: number): [number, string] => [t, fmtTime(t)];

const DEVELOPED = {
  hall: 5,
  lumber: 4,
  quarry: 4,
  mine: 4,
  warehouse: 5,
  barracks: 3,
  harbor: 3,
  wall: 1,
};

function v2(strategy: BotStrategy, seat: PlayerId = "p1", seed = 11) {
  return createBotVersion(strategy, 2, { seat, seed, strict: true });
}

/** A colony (not a capital) of `owner`. */
function colony(
  id: CityId,
  owner: PlayerId,
  island: IslandId,
  units: Record<string, number>,
): FCity {
  const c = capital(id, owner, island, { ...DEVELOPED, wall: 0 }, res(300, 300, 300), units);
  c.capitalOf = null;
  return c;
}

/** `city` besieged by `by` with `garrison`, the siege ending at `ends` (perfidia-1's public extras). */
function besiege(
  city: FCity,
  by: PlayerId,
  home: CityId,
  garrison: Record<string, number>,
  ends: number,
) {
  city.ext = { siege: { by, ends: pair(ends) } };
  city.stationed = [{ owner: by, home, role: "hold", units: garrison }];
  city.units = {};
}

/** The map rows carry each city's public extras, as `view_map` does (the fake leaves them out). */
function withMapExtras(game: FakeGame): void {
  const respond = game.respond.bind(game);
  game.respond = (seat: PlayerId, c: ToolCall) => {
    const r = respond(seat, c);
    if (c.tool !== "view_map" || !r.ok) return r;
    const rows = r.data["cities"];
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
        const id = row["id"];
        const city = typeof id === "string" ? game.cities.find((x) => x.id === id) : undefined;
        if (city !== undefined && Object.keys(city.ext).length > 0) row["ext"] = city.ext;
      }
    }
    return r;
  };
}

/** `city`'s view lists `moves` on their way to it (the fake's views list none). */
function withIncoming(game: FakeGame, city: CityId, moves: readonly JsonObject[]): void {
  const respond = game.respond.bind(game);
  game.respond = (seat: PlayerId, c: ToolCall) => {
    const r = respond(seat, c);
    if (c.tool !== "view_city" || !r.ok || r.data["id"] !== city) return r;
    return { ...r, data: { ...r.data, incoming: [...moves] } };
  };
}

/** A movement of `owner` on its way to `to`, as a full city view lists it. */
function move(
  game: FakeGame,
  id: string,
  kind: "attack" | "support",
  owner: PlayerId,
  from: CityId,
  to: CityId,
  party: PlayerId | null,
  arrive: number,
  units: Record<string, number>,
): JsonObject {
  return {
    id,
    kind,
    access: "full",
    owner,
    from,
    to,
    party,
    depart: pair(game.t - 600),
    arrive: pair(arrive),
    units,
  };
}

/** Every briefing carries `ext` (perfidia-1: the running countdowns). */
function withBriefingExt(game: FakeGame, ext: JsonObject): void {
  const briefing = game.briefing.bind(game);
  game.briefing = (seat: PlayerId, notes?: string, perWake?: number | null): Briefing => ({
    ...briefing(seat, notes, perWake),
    ext,
  });
}

function noViolations(game: FakeGame): void {
  expect(game.violations).toEqual([]);
}

/** The attacks of a turn as `{to, units}`. */
function attacks(
  log: Awaited<ReturnType<typeof playTurn>>,
): { to: string; units: Record<string, number> }[] {
  return callsTo(log, "attack").map((a) => ({ to: str(a["to"]), units: counts(a["units"]) }));
}

describe("relief of a besieged city", () => {
  test("expander@2 sends its attackers against the besieger of its colony when they break the siege", async () => {
    const game = perfidiaGame(6);
    game.t = 2 * DAY + 3600;
    const c1 = game.city("c1");
    c1.levels = { ...DEVELOPED };
    c1.stock = res(900, 900, 900);
    c1.units = { raider: 60, guard: 10, transport: 4 };
    // The colony on its backyard island (80 tiles: 4800 s), besieged by p2 for 5 more hours.
    const c20 = colony("c20", "p1", "i3", {});
    besiege(c20, "p2", "c2", { raider: 12, settler: 1 }, game.t + 5 * 3600);
    game.cities.push(c20);
    const log = await playTurn(v2("expander"), game, "p1");
    noViolations(game);
    const sent = attacks(log);
    expect(sent.map((a) => a.to)).toEqual(["c20"]);
    expect(sent[0]!.units["raider"]).toBe(60);
    // 60 pop across water: three carriers of 20.
    expect(sent[0]!.units["transport"]).toBe(3);
    const memory = parseMemory(game.notes.get("p1") ?? "", "expander");
    expect(memory.m.some((l) => l.startsWith("relief c20 vs p2"))).toBe(true);
  });

  test("expander@2 leaves a garrison it cannot break alone, and never attacks anyone else", async () => {
    const game = perfidiaGame(6);
    game.t = 2 * DAY + 3600;
    const c1 = game.city("c1");
    c1.levels = { ...DEVELOPED };
    c1.units = { raider: 60, guard: 10, transport: 4 };
    const c20 = colony("c20", "p1", "i3", {});
    besiege(c20, "p2", "c2", { raider: 400, guard: 100, settler: 2 }, game.t + 5 * 3600);
    game.cities.push(c20);
    // A weak stranger with fresh intel: the peaceful reference player still leaves it alone.
    game.intel.set("p1|c2", {
      type: "spy_report",
      at: game.t - 600,
      data: { report: "r00001", city: "c2", units: { home: { guard: 1 } } },
    });
    const log = await playTurn(v2("expander"), game, "p1");
    noViolations(game);
    expect(attacks(log)).toEqual([]);
  });

  test("expander@2 lets a relief land: none is sent after the siege's end", async () => {
    const game = perfidiaGame(6);
    game.t = 2 * DAY + 3600;
    const c1 = game.city("c1");
    c1.levels = { ...DEVELOPED };
    c1.units = { raider: 60, transport: 4 };
    const c20 = colony("c20", "p1", "i3", {});
    // The siege ends in an hour; the relief would take 4800 s.
    besiege(c20, "p2", "c2", { raider: 12, settler: 1 }, game.t + 3600);
    game.cities.push(c20);
    const log = await playTurn(v2("expander"), game, "p1");
    expect(attacks(log)).toEqual([]);
  });

  test("turtle@2 relieves its ally's besieged city, but not against a pact partner", async () => {
    for (const pact of [false, true]) {
      const game = perfidiaGame(6);
      withMapExtras(game);
      game.t = 3 * DAY + 3600;
      const c1 = game.city("c1");
      c1.levels = { ...DEVELOPED };
      c1.units = { raider: 40, guard: 120, transport: 10 };
      game.relations.set("p1", [
        { player: "p2", kind: "ally", until: null },
        ...(pact ? [{ player: "p3" as const, kind: "pact" as const, until: null }] : []),
      ]);
      game.relations.set("p2", [{ player: "p1", kind: "ally", until: null }]);
      game.alliance.set("p1", "a1");
      game.alliance.set("p2", "a1");
      besiege(game.city("c2"), "p3", "c3", { raider: 20, settler: 1 }, game.t + 5 * 3600);
      // oxlint-disable-next-line no-await-in-loop -- one game at a time
      const log = await playTurn(v2("turtle"), game, "p1");
      noViolations(game);
      const sent = attacks(log).filter((a) => a.to === "c2");
      if (pact) {
        expect(sent).toEqual([]);
        continue;
      }
      expect(sent.length).toBe(1);
      // Its attackers and half its defenders.
      expect(sent[0]!.units["raider"]).toBe(40);
      expect(sent[0]!.units["guard"]).toBe(60);
    }
  });

  test("turtle@2 sends defenders to an ally's city with an attack on its way", async () => {
    const game = perfidiaGame(6);
    game.t = 3 * DAY + 3600;
    const c1 = game.city("c1");
    c1.levels = { ...DEVELOPED };
    c1.units = { guard: 100, transport: 10 };
    game.relations.set("p1", [{ player: "p2", kind: "ally", until: null }]);
    game.incoming.set("p1", [
      {
        id: "m0k4qz",
        kind: "attack",
        from: "c3",
        by: "p3",
        foe: "p2",
        to: "c2",
        depart: pair(game.t - 1000),
        arrive: pair(game.t + 6 * 3600),
      },
    ]);
    const log = await playTurn(v2("turtle"), game, "p1");
    noViolations(game);
    const supports = callsTo(log, "support");
    expect(supports.map((s) => s["to"])).toEqual(["c2"]);
    const guards = counts(supports[0]!["units"])["guard"] ?? 0;
    expect(guards).toBeGreaterThanOrEqual(30);
    expect(guards).toBeLessThanOrEqual(45);
    // Answered once.
    game.t += 600;
    const again = await playTurn(v2("turtle"), game, "p1", { turn: 2 });
    expect(callsTo(again, "support")).toEqual([]);
  });
});

/**
 * p1 at D3 01:00 with `raiders` (and the carriers to lift them) in its capital; its colony c20 on
 * its backyard island (4800 s away) besieged by p2 with `garrison` for 5 more hours. In the fake,
 * a relief's attack counts × 0.8 (morale without hints) and a garrison's defense × 1.3 + 100.
 */
function reliefGame(raiders: number, garrison: Record<string, number>): FakeGame {
  const game = perfidiaGame(6);
  game.t = 2 * DAY + 3600;
  const c1 = game.city("c1");
  c1.levels = { ...DEVELOPED };
  c1.units = raiders > 0 ? { raider: raiders, transport: Math.ceil(raiders / 20) } : {};
  const c20 = colony("c20", "p1", "i3", {});
  besiege(c20, "p2", "c2", garrison, game.t + 5 * 3600);
  game.cities.push(c20);
  return game;
}

/** Whether expander@2 (seed `seed`) sends a relief to c20 in `game`. */
async function relieves(game: FakeGame, seed = 11): Promise<boolean> {
  const log = await playTurn(v2("expander", "p1", seed), game, "p1");
  noViolations(game);
  return attacks(log).some((a) => a.to === "c20");
}

describe("relief margins", () => {
  test.each([11, 12, 13])(
    "expander@2 (seed %i) needs its winning margin (1.15 to 1.35): not at parity, at 1.36 yes",
    async (seed) => {
      // 30 guards and 3 founders: D = 30 × 20 × 1.3 + 100 = 880. Three founders do not all die
      // in a lost battle that close (the break path needs more), so only a win counts.
      const garrison = { guard: 30, settler: 3 };
      // 55 raiders: A = 55 × 20 × 0.8 = 880, parity.
      expect(await relieves(reliefGame(55, garrison), seed)).toBe(false);
      // 75 raiders: A = 1200, 1.36 × D.
      expect(await relieves(reliefGame(75, garrison), seed)).toBe(true);
    },
  );

  test.each([11, 12, 13])(
    "expander@2 (seed %i) breaks a lone founder's siege from about 0.8 × D, not at 0.69",
    async (seed) => {
      const garrison = { guard: 30, settler: 1 };
      // 38 raiders: A = 608 = 0.69 × 880: the founder may survive.
      expect(await relieves(reliefGame(38, garrison), seed)).toBe(false);
      // 53 raiders: A = 848 = 0.96 × 880: a lost battle still kills the lone founder.
      expect(await relieves(reliefGame(53, garrison), seed)).toBe(true);
    },
  );

  test("expander@2 sends the wave that breaks the siege, not a smaller one that would die first", async () => {
    const game = reliefGame(10, { guard: 30, settler: 3 });
    // A colony on its frontier (8050 s from c20) holds the army that wins alone.
    const c21 = colony("c21", "p1", "i4", { raider: 100, transport: 5 });
    game.cities.push(c21);
    const log = await playTurn(v2("expander"), game, "p1");
    noViolations(game);
    const sent = callsTo(log, "attack").filter((a) => a["to"] === "c20");
    expect(sent.map((a) => a["from"])).toEqual(["c21"]);
  });

  test("a relief in flight that the besieger's supports would beat is called back", async () => {
    for (const reinforced of [false, true]) {
      const game = reliefGame(0, { raider: 12, settler: 1 });
      game.moves.push({
        id: "m1rkf0",
        kind: "attack",
        owner: "p1",
        from: "c1",
        to: "c20",
        island: "i3",
        units: { raider: 60, transport: 3 },
        depart: game.t - 300,
        arrive: game.t + 4500,
        recallableUntil: game.t + 300,
        party: "p2",
      });
      if (reinforced) {
        withIncoming(game, "c20", [
          move(game, "m2spt0", "support", "p2", "c2", "c20", "p1", game.t + 2000, { guard: 200 }),
        ]);
      }
      // oxlint-disable-next-line no-await-in-loop -- one game at a time
      const log = await playTurn(v2("expander"), game, "p1");
      noViolations(game);
      const recalls = callsTo(log, "recall_troops").map((r) => r["movement"]);
      expect(recalls).toEqual(reinforced ? ["m1rkf0"] : []);
    }
  });

  test("turtle@2 leaves an ally's siege to the relief already on its way there", async () => {
    for (const relieved of [false, true]) {
      const game = perfidiaGame(6);
      withMapExtras(game);
      game.t = 3 * DAY + 3600;
      const c1 = game.city("c1");
      c1.levels = { ...DEVELOPED };
      c1.units = { raider: 40, guard: 120, transport: 10 };
      game.relations.set("p1", [{ player: "p2", kind: "ally", until: null }]);
      game.relations.set("p2", [{ player: "p1", kind: "ally", until: null }]);
      game.alliance.set("p1", "a1");
      game.alliance.set("p2", "a1");
      besiege(game.city("c2"), "p3", "c3", { raider: 20, settler: 1 }, game.t + 5 * 3600);
      if (relieved) {
        // p2's own relief from its colony, fighting the besieger.
        withIncoming(game, "c2", [
          move(game, "m3rkf0", "attack", "p2", "c22", "c2", "p3", game.t + 3000, { raider: 50 }),
        ]);
      }
      // oxlint-disable-next-line no-await-in-loop -- one game at a time
      const log = await playTurn(v2("turtle"), game, "p1");
      noViolations(game);
      expect(attacks(log).filter((a) => a.to === "c2").length).toBe(relieved ? 0 : 1);
    }
  });
});

/**
 * The cancels and `max` orders of one turn of `turtle@version` with two attacks on its way to a
 * city that cannot afford a defender (two build items queued).
 */
async function braceTwice(version: number): Promise<{ cancels: number; maxOrders: number }> {
  const game = perfidiaGame(6);
  game.t = 70000;
  const c1 = game.city("c1");
  c1.levels = { ...DEVELOPED };
  c1.stock = res(0, 0, 0);
  c1.build = [
    { item: 7, building: "hall", level: 6, start: game.t - 100, end: game.t + 5000 },
    { item: 8, building: "lumber", level: 5, start: game.t + 5000, end: game.t + 9000 },
  ];
  c1.itemSeq = 8;
  game.incoming.set(
    "p1",
    (["m0k4qz", "m0k4r0"] as const).map((id, i) => ({
      id,
      kind: "attack" as const,
      from: "c2" as const,
      by: "p2" as const,
      foe: "p1" as const,
      to: "c1" as const,
      depart: pair(game.t - 1000),
      arrive: pair(game.t + 5000 + i),
    })),
  );
  const bot = createBotVersion("turtle", version, { seat: "p1", seed: 11, strict: true });
  const log = await playTurn(bot, game, "p1");
  const maxOrders = callsTo(log, "recruit").filter((r) =>
    JSON.stringify(r).includes('"max"'),
  ).length;
  return { cancels: callsTo(log, "cancel_queue").length, maxOrders };
}

describe("turtle@2 braces once per city", () => {
  test("two attacks on one city: one cancel and one max order (turtle@1 cancels the same item twice)", async () => {
    expect(await braceTwice(2)).toEqual({ cancels: 1, maxOrders: 1 });
    expect(await braceTwice(1)).toEqual({ cancels: 2, maxOrders: 2 });
  });
});

/** p1 (the opportunist) allied with p2 on its betrayal day, with an army; p2's capital is weak. */
function betrayalDay(seed: number): FakeGame {
  const prm = opportunist2Params(streamOf(seed, "p1", "opportunist", "params"));
  const game = perfidiaGame(6);
  game.t = prm.betrayDay * DAY + 3600;
  const c1 = game.city("c1");
  c1.levels = { ...DEVELOPED };
  c1.units = { raider: 40, transport: 3, guard: 10 };
  game.city("c2").units = { guard: 3 };
  game.relations.set("p1", [{ player: "p2", kind: "ally", until: null }]);
  game.relations.set("p2", [{ player: "p1", kind: "ally", until: null }]);
  game.alliance.set("p1", "a1");
  game.alliance.set("p2", "a1");
  return game;
}

describe("opportunist@2", () => {
  test("betrays on its seeded day, but never while its own bloc runs a countdown", async () => {
    const seed = 11;
    const free = betrayalDay(seed);
    const log = await playTurn(v2("opportunist", "p1", seed), free, "p1");
    noViolations(free);
    expect(attacks(log).map((a) => a.to)).toContain("c2");
    expect(callsTo(log, "send_message").map((m) => m["text"])).toContain("we remain friends");

    const counting = betrayalDay(seed);
    withBriefingExt(counting, {
      countdowns: [
        { key: "a1", members: ["p1", "p2"], cities: 12, need: 12, ends: pair(counting.t + 50000) },
      ],
    });
    const held = await playTurn(v2("opportunist", "p1", seed), counting, "p1");
    noViolations(counting);
    expect(attacks(held).map((a) => a.to)).not.toContain("c2");
    expect(callsTo(held, "send_message")).toEqual([]);
  });

  test("waits for the countdown instead of betraying while its bloc is within 2 cities of the threshold", async () => {
    const seed = 11;
    // p1 and p2 hold 2 cities: a threshold of 4 is within reach, one of 5 is not.
    for (const need of [4, 5]) {
      const game = betrayalDay(seed);
      const respond = game.respond.bind(game);
      game.respond = (seat: PlayerId, c: ToolCall) => {
        const r = respond(seat, c);
        if (c.tool !== "leaderboard" || !r.ok) return r;
        return { ...r, data: { ...r.data, ext: { domination: { need } } } };
      };
      // oxlint-disable-next-line no-await-in-loop -- one game at a time
      const log = await playTurn(v2("opportunist", "p1", seed), game, "p1");
      noViolations(game);
      const betrays = attacks(log).some((a) => a.to === "c2");
      expect([need, betrays]).toEqual([need, need === 5]);
    }
  });

  test("with 1.1.0's hints, a bloc short of taken cities is not in reach: the betrayal goes ahead", async () => {
    const seed = 11;
    const outcomes: [string, number, boolean][] = [];
    for (const ref of ["perfidia-1@1.0.0", "perfidia-1@1.1.0"]) {
      for (const taken of [1, 2]) {
        const game = betrayalDay(seed);
        Object.defineProperty(game, "rules", { value: { ...game.rules, ruleset: ref } });
        const respond = game.respond.bind(game);
        game.respond = (seat: PlayerId, c: ToolCall) => {
          const r = respond(seat, c);
          if (c.tool !== "leaderboard" || !r.ok) return r;
          return { ...r, data: { ...r.data, ext: { domination: { need: 4, needTaken: 2 } } } };
        };
        const bloc = { key: "a1", members: ["p1", "p2"], cities: 2, taken, need: 4, needTaken: 2 };
        withBriefingExt(game, { countdowns: [], bloc });
        // oxlint-disable-next-line no-await-in-loop -- one game at a time
        const log = await playTurn(v2("opportunist", "p1", seed), game, "p1");
        noViolations(game);
        outcomes.push([ref, taken, attacks(log).some((a) => a.to === "c2")]);
      }
    }
    // 1.0.0's hints have no taken cities: within 2 cities of the threshold, it waits. With 1.1.0's,
    // it waits only when its bloc also holds the taken cities asked for.
    expect(outcomes).toEqual([
      ["perfidia-1@1.0.0", 1, false],
      ["perfidia-1@1.0.0", 2, false],
      ["perfidia-1@1.1.0", 1, true],
      ["perfidia-1@1.1.0", 2, false],
    ]);
  });

  test("turns back a betrayal still in its recall window once its own bloc's countdown starts", async () => {
    const seed = 11;
    for (const counting of [false, true]) {
      const game = betrayalDay(seed);
      game.moves.push({
        id: "m4btr0",
        kind: "attack",
        owner: "p1",
        from: "c1",
        to: "c2",
        island: "i6",
        units: { raider: 40, transport: 2 },
        depart: game.t - 120,
        arrive: game.t + 9000,
        recallableUntil: game.t + 480,
      });
      game.city("c1").units = { guard: 10, transport: 1 };
      if (counting) {
        withBriefingExt(game, {
          countdowns: [
            { key: "a1", members: ["p1", "p2"], cities: 12, need: 12, ends: pair(game.t + 86000) },
          ],
        });
      }
      // oxlint-disable-next-line no-await-in-loop -- one game at a time
      const log = await playTurn(v2("opportunist", "p1", seed), game, "p1");
      noViolations(game);
      const recalls = callsTo(log, "recall_troops").map((r) => r["movement"]);
      expect([counting, recalls]).toEqual([counting, counting ? ["m4btr0"] : []]);
    }
  });

  test("raids a weak stranger on a fresh spy report, and spies one it knows nothing about", async () => {
    const game = perfidiaGame(6);
    game.t = DAY + 3600;
    const c1 = game.city("c1");
    c1.levels = { ...DEVELOPED };
    c1.units = { raider: 40, transport: 3, guard: 10 };
    game.intel.set("p1|c2", {
      type: "spy_report",
      at: game.t - 600,
      data: { report: "r00001", city: "c2", units: { home: { guard: 2 } } },
    });
    const log = await playTurn(v2("opportunist"), game, "p1");
    noViolations(game);
    expect(attacks(log).map((a) => a.to)).toEqual(["c2"]);

    const blind = perfidiaGame(6);
    blind.t = DAY + 3600;
    const b1 = blind.city("c1");
    b1.levels = { ...DEVELOPED };
    b1.units = { raider: 40, transport: 3, guard: 10 };
    b1.stock = res(900, 900, 900);
    const scouting = await playTurn(v2("opportunist"), blind, "p1");
    noViolations(blind);
    expect(attacks(scouting)).toEqual([]);
    expect(callsTo(scouting, "spy").length).toBe(1);
  });

  test("proposes an alliance to a neighbour seen attacking once it has no ally", async () => {
    const game = perfidiaGame(6);
    game.t = DAY + 7200;
    game.city("c1").levels = { ...DEVELOPED };
    // p3 is farther than p2 and p6, but it was seen attacking.
    withBriefingExt(game, {});
    const briefing = game.briefing.bind(game);
    game.briefing = (seat, notes, perWake) => ({
      ...briefing(seat, notes, perWake),
      news: [
        {
          type: "battle",
          attacker: "p3",
          defender: "p4",
          city: "c4",
          kind: "city",
          winner: "attacker",
        },
      ],
    });
    const log = await playTurn(v2("opportunist"), game, "p1");
    noViolations(game);
    const offers = callsTo(log, "propose_alliance").filter((o) => o["kind"] === "alliance");
    expect(offers.map((o) => o["to"])).toEqual(["p3"]);
  });
});

/** p1 with founders and attackers; p2 and p3 a bloc; p2's colony on p1's frontier is weak. */
function leaderGame(countdown: boolean): FakeGame {
  const game = perfidiaGame(6);
  game.t = 4 * DAY + 3600;
  const c1 = game.city("c1");
  c1.levels = { ...DEVELOPED };
  c1.units = { raider: 80, settler: 2, transport: 6, guard: 20 };
  c1.stock = res(900, 900, 900);
  const c20 = colony("c20", "p2", "i4", { guard: 5 });
  game.cities.push(c20);
  game.intel.set("p1|c20", {
    type: "spy_report",
    at: game.t - 600,
    data: { report: "r00001", city: "c20", units: { home: { guard: 5 } } },
  });
  game.relations.set("p2", [{ player: "p3", kind: "ally", until: null }]);
  if (countdown) {
    withBriefingExt(game, {
      countdowns: [
        { key: "a1", members: ["p2", "p3"], cities: 12, need: 12, ends: pair(game.t + 80000) },
      ],
    });
  }
  return game;
}

describe("stop the leader", () => {
  test("expander@2 strikes the weakest city of a bloc whose countdown runs, with its founders", async () => {
    const game = leaderGame(true);
    const log = await playTurn(v2("expander"), game, "p1");
    noViolations(game);
    const sent = attacks(log);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((a) => a.to === "c20")).toBe(true);
    expect(sent.reduce((n, a) => n + (a.units["settler"] ?? 0), 0)).toBeGreaterThan(0);
    // It founds no city with them.
    expect(callsTo(log, "found_city")).toEqual([]);
  });

  test("expander@2 and turtle@2 never strike a pact partner's city; opportunist@2 does", async () => {
    for (const strategy of ["expander", "turtle", "opportunist"] as const) {
      const game = leaderGame(true);
      game.relations.set("p1", [{ player: "p2", kind: "pact", until: null }]);
      game.relations.set("p2", [
        { player: "p3", kind: "ally", until: null },
        { player: "p1", kind: "pact", until: null },
      ]);
      // oxlint-disable-next-line no-await-in-loop -- one game at a time
      const log = await playTurn(v2(strategy), game, "p1");
      noViolations(game);
      const struck = attacks(log).some((a) => a.to === "c20");
      expect([strategy, struck]).toEqual([strategy, strategy === "opportunist"]);
    }
  });

  test("without a countdown the same expander@2 attacks nobody", async () => {
    const game = leaderGame(false);
    const log = await playTurn(v2("expander"), game, "p1");
    noViolations(game);
    expect(attacks(log)).toEqual([]);
  });
});

/**
 * p1 developed, with resources for a few packs of units and empty queues; every slot of the map
 * is taken (by p6), so no founder is recruited in front of the units.
 */
function pacingGame(ownWakesLeft: number): FakeGame {
  const game = perfidiaGame(6);
  game.t = DAY + 7200;
  game.budget.ownWakesLeft = ownWakesLeft;
  const c1 = game.city("c1");
  c1.levels = { ...DEVELOPED, hall: 10, warehouse: 10, lumber: 10, quarry: 10, mine: 10 };
  c1.stock = res(9000, 9000, 9000);
  for (const isl of game.islands) {
    for (let slot = 0; slot < isl.slots; slot += 1) {
      if (game.cities.some((c) => c.island === isl.id && c.slot === slot)) continue;
      const filler = colony(`c${game.cities.length + 1}`, "p6", isl.id, {});
      filler.slot = slot;
      game.cities.push(filler);
    }
  }
  return game;
}
/** The recruit orders of a turn that name `unit`. */
const recruitsIn = (log: Awaited<ReturnType<typeof playTurn>>, unit: string): number =>
  callsTo(log, "recruit").filter((r) => JSON.stringify(r).includes(`"${unit}"`)).length;

describe("own-wake pacing", () => {
  test("expander@2 starts no batch in an empty queue that would end before its next own wake", async () => {
    // With wakes to spare, a batch lasting past its cadence (about 8 h of units) is ordered.
    const spare = pacingGame(12);
    const before = await playTurn(v2("expander"), spare, "p1");
    noViolations(spare);
    expect(recruitsIn(before, "guard")).toBe(1);
    // Two own wakes for the rest of the day (one every 11 h): the same batch would end, and wake
    // the seat, long before the next one; the resources wait.
    const low = pacingGame(2);
    const after = await playTurn(v2("expander"), low, "p1");
    noViolations(low);
    expect(recruitsIn(after, "guard")).toBe(0);
    // expander@1 does not pace.
    const old = pacingGame(2);
    const v1 = createBotVersion("expander", 1, { seat: "p1", seed: 11, strict: true });
    expect(recruitsIn(await playTurn(v1, old, "p1"), "guard")).toBe(1);
  });
});

/**
 * `pacingGame` (D2 02:00, no free slot) with producers to raise, `used` own wakes spent today and
 * `stock` of each resource.
 */
function idleBuilder(used: number, stock: number): FakeGame {
  const game = pacingGame(12 - used);
  const c1 = game.city("c1");
  c1.levels = { ...DEVELOPED, warehouse: 10 };
  c1.stock = res(stock, stock, stock);
  return game;
}

describe("own-wake pacing of the build queue", () => {
  const STRATEGIES: BotStrategy[] = ["expander", "turtle", "opportunist"];

  test.each(STRATEGIES)(
    "%s@2 builds on its first wake, on sandbox-1 (8 own wakes a day) as on perfidia-1",
    async (strategy) => {
      // sandbox-1: the rest of the day over 8 own wakes is 3 h a wake, more than every cadence.
      const sandbox = sandboxGame(6);
      sandbox.budget.ownWakesLeft = 8;
      const s = await playTurn(v2(strategy), sandbox, "p1");
      noViolations(sandbox);
      expect(callsTo(s, "build").length).toBeGreaterThan(0);
      // perfidia-1: 2 h a wake, more than opportunist@2's cadence (90 to 120 min).
      const perfidia = perfidiaGame(6);
      const p = await playTurn(v2(strategy), perfidia, "p1");
      noViolations(perfidia);
      expect(callsTo(p, "build").length).toBeGreaterThan(0);
    },
  );

  test.each(STRATEGIES)(
    "%s@2 waits with an idle build queue once ahead of an even share of its wakes, unless its store is nearly full",
    async (strategy) => {
      // One own wake by 02:00 keeps to the share (12 a day: one per 2 h).
      const onPace = idleBuilder(1, 3000);
      const a = await playTurn(v2(strategy), onPace, "p1");
      noViolations(onPace);
      expect(callsTo(a, "build").length).toBeGreaterThan(0);
      // Five by 02:00: the item could end, and wake the seat, before its next wake; it waits.
      const ahead = idleBuilder(5, 3000);
      const b = await playTurn(v2(strategy), ahead, "p1");
      noViolations(ahead);
      expect(callsTo(b, "build")).toEqual([]);
      // The same, with a store nearly full: its production would be lost, it builds.
      const full = idleBuilder(5, 8000);
      const c = await playTurn(v2(strategy), full, "p1");
      noViolations(full);
      expect(callsTo(c, "build").length).toBeGreaterThan(0);
    },
  );
});

describe("determinism", () => {
  test.each(["expander", "turtle", "opportunist"] as const)(
    "%s@2: the same inputs give the same calls",
    async (strategy) => {
      const play = async () => {
        const game = leaderGameFor();
        const log = await playTurn(v2(strategy), game, "p1");
        return JSON.stringify(log.calls);
      };
      expect(await play()).toBe(await play());
    },
  );
});

/** A busy position: a besieged colony, an incoming attack, a rival countdown. */
function leaderGameFor(): FakeGame {
  const game = perfidiaGame(6);
  withMapExtras(game);
  game.t = 4 * DAY + 3600;
  const c1 = game.city("c1");
  c1.levels = { ...DEVELOPED };
  c1.units = { raider: 80, settler: 1, transport: 6, guard: 40 };
  c1.stock = res(900, 900, 900);
  const c20 = colony("c20", "p1", "i3", {});
  besiege(c20, "p2", "c2", { raider: 12, settler: 1 }, game.t + 5 * 3600);
  game.cities.push(c20);
  game.incoming.set("p1", [
    {
      id: "m0k4qz",
      kind: "attack",
      from: "c3",
      by: "p3",
      foe: "p1",
      to: "c1",
      depart: pair(game.t - 1000),
      arrive: pair(game.t + 5 * 3600),
    },
  ]);
  withBriefingExt(game, {
    countdowns: [{ key: "p4", members: ["p4"], cities: 12, need: 12, ends: pair(game.t + 80000) }],
  });
  return game;
}
