// Fixture behaviours of the four strategies (docs/architecture.md §11.2, T09 acceptance), each on
// rules shaped like perfidia-1 and like sandbox-1.

import { describe, expect, test } from "bun:test";
import type {
  AgentRules,
  CityId,
  IslandId,
  MovementId,
  PlayerId,
  SeatAgent,
} from "@perfidia/protocol";
import {
  advance,
  callsTo,
  capital,
  counts,
  inSequence,
  perfidiaGame,
  playTurn,
  res,
  sandboxGame,
  str,
  strs,
  upTo,
  type FakeGame,
  type FCity,
} from "./fixtures.test.ts";
import type { StrategyHints } from "./hints.ts";
import { fmtTime } from "./kit.ts";
import { parseMemory } from "./memory.ts";
import { botFromLabel, botLabels, botVersions, createBot, createBotVersion } from "./registry.ts";
import { streamOf } from "./rng.ts";
import { opportunistParams } from "./strategies/opportunist.ts";
import { rusherParams } from "./strategies/rusher.ts";
import type { BotStrategy } from "./strategies/strategy.ts";

const DAY = 86400;
const pair = (t: number): [number, string] => [t, fmtTime(t)];

interface Shape {
  readonly name: string;
  game(): FakeGame;
  readonly defender: string;
  readonly attacker: string;
  readonly founder: string;
  readonly carrier: string;
  /** Levels where every unit of the fixture can be recruited. */
  readonly developed: Record<string, number>;
}

const SHAPES: Shape[] = [
  {
    name: "perfidia-1 shape",
    game: () => perfidiaGame(6),
    defender: "guard",
    attacker: "raider",
    founder: "settler",
    carrier: "transport",
    developed: {
      hall: 5,
      lumber: 4,
      quarry: 4,
      mine: 4,
      warehouse: 5,
      barracks: 3,
      harbor: 3,
      wall: 1,
    },
  },
  {
    name: "sandbox-1 shape",
    game: () => sandboxGame(6),
    defender: "spearman",
    attacker: "axeman",
    founder: "colonist",
    carrier: "boat",
    developed: { keep: 3, sawmill: 3, pit: 3, forge: 3, depot: 3, camp: 2, docks: 1 },
  },
];

/**
 * p1 and p2 bound by a pact on `day`: p2's cities are public views to p1, known only through
 * reports. p1 has an army, p2's capital is weak.
 */
function pactPair(shape: Shape, day: number): FakeGame {
  const game = shape.game();
  game.t = day * DAY + 3600;
  const c1 = game.city("c1");
  c1.levels = { ...shape.developed };
  c1.stock = res(900, 900, 900);
  c1.units = { [shape.attacker]: 40, [shape.carrier]: 3, [shape.defender]: 10 };
  game.city("c2").units = { [shape.defender]: 3 };
  game.relations.set("p1", [{ player: "p2", kind: "pact", until: null }]);
  game.relations.set("p2", [{ player: "p1", kind: "pact", until: null }]);
  return game;
}

/** p1 and p2 allied on `day`; p1 has an army, p2's capital is weak. */
function alliedPair(shape: Shape, day: number): FakeGame {
  const game = shape.game();
  game.t = day * DAY + 3600;
  const c1 = game.city("c1");
  c1.levels = { ...shape.developed };
  c1.units = { [shape.attacker]: 40, [shape.carrier]: 3, [shape.defender]: 10 };
  game.city("c2").units = { [shape.defender]: 3 };
  game.relations.set("p1", [{ player: "p2", kind: "ally", until: null }]);
  game.relations.set("p2", [{ player: "p1", kind: "ally", until: null }]);
  game.alliance.set("p1", "a1");
  game.alliance.set("p2", "a1");
  return game;
}

/** At t = 5000, p2 and p4 offer p1 an alliance and p3 offers it a pact. */
function offerTwoAlliancesAndAPact(game: FakeGame): void {
  game.t = 5000;
  for (const [id, from, kind] of [
    ["q0000a", "p2", "alliance"],
    ["q0000b", "p3", "pact"],
    ["q0000c", "p4", "alliance"],
  ] as const) {
    game.proposals.push({
      id,
      from,
      to: "p1",
      kind,
      name: kind === "alliance" ? "North" : null,
      text: "join",
      expires: pair(40000),
    });
  }
}

function bot(strategy: BotStrategy, seat: PlayerId = "p1", seed = 11) {
  return createBot(strategy, { seat, seed, strict: true });
}

/** The rusher these fixtures describe: version 1, frozen since its goldens (rusher@2: rusher2.test.ts). */
function rusherV1(seat: PlayerId = "p1", seed = 11, hints?: StrategyHints) {
  return createBotVersion("rusher", 1, {
    seat,
    seed,
    strict: true,
    ...(hints === undefined ? {} : { hints }),
  });
}

function noViolations(game: FakeGame): void {
  expect(game.violations).toEqual([]);
}

/** The buildings that unlock `unit`: its recruit building, its requirements, theirs, and so on. */
function unlockClosure(rules: AgentRules, unit: string): Set<string> {
  const row = rules.units.find((u) => u.id === unit)!;
  const queue = rules.queues.recruit.find((q) => q.id === row.queue)!;
  const out = new Set<string>();
  const visit = (b: string): void => {
    if (out.has(b)) return;
    out.add(b);
    for (const req of Object.keys(rules.buildings.find((x) => x.id === b)?.requires ?? {})) {
      visit(req);
    }
  };
  for (const b of [queue.building, ...Object.keys(row.requires)]) visit(b);
  return out;
}

/** A city of `owner` on `island`, not a capital (a colony). */
function colonyOf(
  shape: Shape,
  id: CityId,
  owner: PlayerId,
  island: IslandId,
  slot: number,
  units: Record<string, number>,
): FCity {
  const c = capital(id, owner, island, shape.developed, res(300, 300, 300), units);
  c.slot = slot;
  c.capitalOf = null;
  return c;
}

/** Fresh spy intel of p1 about `city`: `n` defenders at home. */
function weakIntel(game: FakeGame, shape: Shape, city: string, n: number, age = 3600): void {
  game.intel.set(`p1|${city}`, {
    type: "spy_report",
    at: game.t - age,
    data: { report: "r00001", city, units: { home: { [shape.defender]: n } } },
  });
}

const MOVES = ["attack", "support", "spy", "found_city", "send_resources"] as const;

describe.each(SHAPES)("$name", (shape) => {
  test("expander queues economy first: producers, storage, population and the founder's unlock", async () => {
    const game = shape.game();
    const log = await playTurn(bot("expander"), game, "p1");
    noViolations(game);
    const builds = callsTo(log, "build");
    expect(builds.length).toBe(1);
    const items = strs(builds[0]!["buildings"]);
    const roles = game.rules.roles;
    const founder = unlockClosure(game.rules, roles.settler);
    const economy = new Set([roles.storage, roles.population, ...Object.values(roles.producers)]);
    expect(items.length).toBeGreaterThan(0);
    // perfidia-1 §15.1: economy first, settlers unlocked early (hall 2, hall 3, barracks 2).
    for (const b of items) expect(economy.has(b) || founder.has(b)).toBe(true);
    expect(items.some((b) => founder.has(b))).toBe(true);
    // Nothing military of its own: no wall, no carriers' building.
    const carrierQueue = game.rules.units.find((u) => u.id === shape.carrier)!.queue;
    expect(items).not.toContain(carrierQueue);
    if (roles.wall !== null) expect(items).not.toContain(roles.wall);
    expect(callsTo(log, "attack")).toEqual([]);
    expect(log.endedBy).toBe("end_turn");
  });

  test("expander counts every founder heading for one island", async () => {
    const game = shape.game();
    game.t = 30000;
    const c1 = game.city("c1");
    c1.levels = { ...shape.developed };
    c1.stock = res(0, 0, 0);
    c1.units = { [shape.founder]: 3, [shape.defender]: 10, [shape.carrier]: 6 };
    // The home island's second slot is taken: the 2-slot island nearby is the best for each.
    game.cities.push(colonyOf(shape, "c20", "p1", c1.island, 1, {}));
    const b = createBot("expander", { seat: "p1", seed: 11, strict: true, hints: null });
    const log = await playTurn(b, game, "p1");
    noViolations(game);
    const islands = callsTo(log, "found_city").map((f) => str(f["island"]));
    const best = islands[0]!;
    // Two founders for its two free slots, never a third.
    expect(islands.filter((i) => i === best).length).toBe(2);
    expect(islands.length).toBe(3);
    const memory = parseMemory(game.notes.get("p1") ?? "", "expander");
    expect(memory.f[best]?.length).toBe(2);

    // Next turn, with both still under way and a new founder at home: the island looks full.
    game.t += 600;
    c1.units[shape.founder] = 1;
    const next = await playTurn(b, game, "p1", { turn: 2 });
    expect(callsTo(next, "found_city").map((f) => f["island"])).not.toContain(best);
  });

  test("expander sends a founder to the nearest valuable free slot", async () => {
    const game = shape.game();
    game.t = 30000;
    const c1 = game.city("c1");
    c1.levels = { ...shape.developed };
    c1.stock = res(900, 900, 900);
    c1.units = { [shape.founder]: 1, [shape.defender]: 10, [shape.carrier]: 3 };
    // The home island's second slot is taken by the seat's own colony.
    const colony = capital("c20", "p1", c1.island, shape.developed, res(100, 100, 100), {});
    colony.slot = 1;
    colony.capitalOf = null;
    game.cities.push(colony);

    const log = await playTurn(bot("expander"), game, "p1");
    noViolations(game);
    const founds = callsTo(log, "found_city");
    expect(founds.length).toBe(1);
    const f = founds[0]!;
    expect(f["from"]).toBe("c1");
    // Ranked by richness per travel second among free slots: the nearest rich island wins over a
    // nearer poor one (perfidia shape: the frontier i4 over the backyard i3; sandbox: shared i2).
    expect(f["island"]).toBe(shape.name.startsWith("perfidia") ? "i4" : "i2");
    const units = counts(f["units"]);
    expect(units[shape.founder]).toBe(1);
    expect(units[shape.carrier]).toBeGreaterThanOrEqual(1);
    if (game.rules.toolOptions.foundSlot) expect(f["slot"]).toBe(0);
    else expect(f["slot"]).toBeUndefined();
    // The founding is remembered (own `found` movements do not show their island).
    const notes = game.notes.get("p1") ?? "";
    expect(Object.keys(parseMemory(notes, "expander").f)).toEqual([str(f["island"])]);
  });

  test("expander never attacks and supports its own threatened city", async () => {
    const game = shape.game();
    game.t = 60000;
    const c1 = game.city("c1");
    c1.levels = { ...shape.developed };
    c1.units = { [shape.defender]: 20, [shape.attacker]: 20, [shape.carrier]: 4 };
    const colony = capital("c20", "p1", c1.island, shape.developed, res(100, 100, 100), {});
    colony.slot = 1;
    colony.capitalOf = null;
    game.cities.push(colony);
    game.incoming.set("p1", [
      {
        id: "m0k4qz",
        kind: "attack",
        from: "c2",
        by: "p2",
        foe: "p1",
        to: "c20",
        depart: pair(game.t - 1000),
        arrive: pair(game.t + 9000),
      },
    ]);
    const log = await playTurn(bot("expander"), game, "p1");
    noViolations(game);
    expect(callsTo(log, "attack")).toEqual([]);
    const supports = callsTo(log, "support");
    expect(supports.length).toBe(1);
    expect(supports[0]).toMatchObject({ from: "c1", to: "c20", units: { [shape.defender]: 10 } });
  });

  test("rusher attacks a weak target above its margin", async () => {
    const game = shape.game();
    game.t = game.rules.time.attackFrom + 7200;
    const c1 = game.city("c1");
    c1.levels = { ...shape.developed };
    c1.units = { [shape.attacker]: 30, [shape.carrier]: 3, [shape.defender]: 10 };
    game.intel.set("p1|c2", {
      type: "spy_report",
      at: game.t - 3600,
      data: { report: "r00001", city: "c2", units: { home: { [shape.defender]: 2 } } },
    });
    const log = await playTurn(rusherV1(), game, "p1");
    noViolations(game);
    const attacks = callsTo(log, "attack");
    expect(attacks.length).toBe(1);
    const a = attacks[0]!;
    expect(a["to"]).toBe("c2");
    const units = counts(a["units"]);
    expect(units[shape.attacker]).toBe(30);
    expect(units[shape.carrier]).toBeGreaterThanOrEqual(2);
    expect(units[shape.defender]).toBeUndefined();
  });

  test("rusher holds back from a target stronger than its margin", async () => {
    const game = shape.game();
    game.t = game.rules.time.attackFrom + 7200;
    const c1 = game.city("c1");
    c1.levels = { ...shape.developed };
    c1.units = { [shape.attacker]: 30, [shape.carrier]: 3 };
    // 30 attackers: perfidia 600, sandbox 450 attack; 40 defenders: 800 and 600 defense.
    game.intel.set("p1|c2", {
      type: "spy_report",
      at: game.t - 3600,
      data: { report: "r00001", city: "c2", units: { home: { [shape.defender]: 40 } } },
    });
    const log = await playTurn(rusherV1(), game, "p1");
    noViolations(game);
    expect(callsTo(log, "attack").filter((a) => a["to"] === "c2")).toEqual([]);
  });

  test("rusher recalls within the window on a fresher, stronger report (when the rules allow it)", async () => {
    const game = shape.game();
    game.t = game.rules.time.attackFrom + 7200;
    const c1 = game.city("c1");
    c1.levels = { ...shape.developed };
    const id: MovementId = "m00abc";
    game.moves.push({
      id,
      kind: "attack",
      owner: "p1",
      from: "c1",
      to: "c2",
      island: game.city("c2").island,
      units: { [shape.attacker]: 30, [shape.carrier]: 2 },
      depart: game.t - 300,
      arrive: game.t + 9000,
      recallableUntil: game.t + 300,
    });
    game.intel.set("p1|c2", {
      type: "spy_report",
      at: game.t - 100,
      data: { report: "r00002", city: "c2", units: { home: { [shape.defender]: 200 } } },
    });
    const log = await playTurn(rusherV1(), game, "p1");
    noViolations(game);
    const recalls = callsTo(log, "recall_troops");
    if (game.rules.movement.recall.kinds.includes("attack")) {
      expect(recalls).toEqual([{ movement: id }]);
    } else {
      expect(recalls).toEqual([]);
    }
  });

  test("rusher keeps an attack when the report predates the launch", async () => {
    const game = shape.game();
    game.t = game.rules.time.attackFrom + 7200;
    game.city("c1").levels = { ...shape.developed };
    game.moves.push({
      id: "m00abd",
      kind: "attack",
      owner: "p1",
      from: "c1",
      to: "c2",
      island: game.city("c2").island,
      units: { [shape.attacker]: 30 },
      depart: game.t - 300,
      arrive: game.t + 9000,
      recallableUntil: game.t + 300,
    });
    game.intel.set("p1|c2", {
      type: "spy_report",
      at: game.t - 4000,
      data: { report: "r00003", city: "c2", units: { home: { [shape.defender]: 200 } } },
    });
    const log = await playTurn(rusherV1(), game, "p1");
    expect(callsTo(log, "recall_troops")).toEqual([]);
  });

  test("rusher keeps an attack when the only fresher report is a battle report", async () => {
    const game = shape.game();
    game.t = game.rules.time.attackFrom + 7200;
    game.city("c1").levels = { ...shape.developed };
    game.moves.push({
      id: "m00abe",
      kind: "attack",
      owner: "p1",
      from: "c1",
      to: "c2",
      island: game.city("c2").island,
      units: { [shape.attacker]: 30 },
      depart: game.t - 300,
      arrive: game.t + 9000,
      recallableUntil: game.t + 300,
    });
    // A third party's battle at c2, after the launch: both sides, before / lost / survived.
    game.intel.set("p1|c2", {
      type: "battle_report",
      at: game.t - 100,
      data: {
        attacker: "p3",
        foe: "p2",
        winner: "defender",
        stacks: {
          p3: { before: { [shape.attacker]: 500 }, lost: { [shape.attacker]: 500 } },
          p2: { before: { [shape.defender]: 50 }, lost: { [shape.defender]: 20 } },
        },
      },
    });
    const log = await playTurn(rusherV1(), game, "p1");
    noViolations(game);
    expect(callsTo(log, "recall_troops")).toEqual([]);
  });

  test("rusher spies the nearest stranger it knows nothing about, then attacks on the report", async () => {
    const game = shape.game();
    game.t = game.rules.time.attackFrom;
    const c1 = game.city("c1");
    c1.levels = { ...shape.developed };
    c1.stock = res(900, 900, 900);
    c1.units = { [shape.attacker]: 30, [shape.carrier]: 3, [shape.defender]: 10 };
    game.city("c2").units = { [shape.defender]: 2 };
    const b = rusherV1();
    const first = await playTurn(b, game, "p1");
    noViolations(game);
    const spies = callsTo(first, "spy");
    expect(spies.length).toBe(1);
    expect(spies[0]).toMatchObject({ from: "c1", to: "c2" });
    expect(Number(spies[0]!["gold"])).toBeGreaterThanOrEqual(game.rules.movement.spyMinGold);
    expect(callsTo(first, "attack")).toEqual([]);

    // While the spy is under way it neither spies c2 again nor attacks blind.
    game.t += 600;
    const second = await playTurn(b, game, "p1", { turn: 2 });
    expect(callsTo(second, "spy").filter((s) => s["to"] === "c2")).toEqual([]);
    expect(callsTo(second, "attack")).toEqual([]);

    // The report lands (2 defenders): far below its margin, so it attacks.
    const spy = game.moves.find((m) => m.kind === "spy" && m.to === "c2")!;
    advance(game, spy.arrive);
    const third = await playTurn(b, game, "p1", { turn: 3 });
    noViolations(game);
    expect(callsTo(third, "attack").map((a) => a["to"])).toEqual(["c2"]);
  });

  test("rusher spies again only when its intel is stale", async () => {
    const prm = rusherParams(streamOf(11, "p1", "rusher", "params"));
    const setup = (age: number): FakeGame => {
      const game = shape.game();
      game.t = game.rules.time.attackFrom + 4 * 3600;
      const c1 = game.city("c1");
      c1.levels = { ...shape.developed };
      c1.stock = res(900, 900, 900);
      // Too few attackers to attack anything: only the spying is at stake.
      c1.units = { [shape.attacker]: prm.minAttackers - 1, [shape.carrier]: 3 };
      game.city("c2").units = { [shape.defender]: 40 };
      weakIntel(game, shape, "c2", 40, age);
      return game;
    };
    const fresh = await playTurn(rusherV1(), setup(prm.stale), "p1");
    expect(callsTo(fresh, "spy").filter((s) => s["to"] === "c2")).toEqual([]);
    const stale = await playTurn(rusherV1(), setup(prm.stale + 1), "p1");
    expect(callsTo(stale, "spy").map((s) => s["to"])).toContain("c2");
  });

  test("rusher brings exactly two founders to a weak colony, none otherwise", async () => {
    const prm = rusherParams(streamOf(11, "p1", "rusher", "params"));
    const strength = 40 * (shape.name.startsWith("perfidia") ? 20 : 15);
    const defense = shape.name.startsWith("perfidia") ? 20 : 15;
    const setup = (founders: number, target: "colony" | "capital", defenders: number) => {
      const game = shape.game();
      game.t = game.rules.time.attackFrom + 7200;
      const c1 = game.city("c1");
      c1.levels = { ...shape.developed };
      c1.units = { [shape.attacker]: 40, [shape.carrier]: 5 };
      if (founders > 0) c1.units[shape.founder] = founders;
      if (target === "colony") {
        // p2's colony on the island next to c1, the nearest stranger.
        const near = game.islands.find((i) => i.kind !== "home" && i.kind !== "crown")!;
        game.cities.push(colonyOf(shape, "c21", "p2", near.id, 0, { [shape.defender]: defenders }));
        weakIntel(game, shape, "c21", defenders);
      } else {
        weakIntel(game, shape, "c2", defenders);
      }
      return game;
    };
    const founderCount = async (game: FakeGame): Promise<number | null> => {
      const log = await playTurn(rusherV1(), game, "p1");
      noViolations(game);
      const attacks = callsTo(log, "attack");
      expect(attacks.length).toBe(1);
      return counts(attacks[0]!["units"])[shape.founder] ?? 0;
    };
    // Weak colony, two founders at home: a conquest attempt with exactly two.
    expect(await founderCount(setup(2, "colony", 1))).toBe(2);
    // Three at home: still two.
    expect(await founderCount(setup(3, "colony", 1))).toBe(2);
    // Only one at home: the plain raid, no lone founder.
    expect(await founderCount(setup(1, "colony", 1))).toBe(0);
    // A capital: a raid.
    expect(await founderCount(setup(2, "capital", 1))).toBe(0);
    // A colony above its margin but not twice: a raid.
    const strong = Math.floor((strength * 1000) / (prm.marginPm * defense));
    expect(strong * defense * prm.marginPm * 2).toBeGreaterThan(strength * 1000);
    expect(await founderCount(setup(2, "colony", strong))).toBe(0);
  });

  test("bots never spy or attack a city whose tag the hints avoid", async () => {
    const hints: StrategyHints = { settleOrder: [], avoidTags: ["crown"], blockedExt: [] };
    const game = shape.game();
    game.t = game.rules.time.attackFrom + 7200;
    const c1 = game.city("c1");
    c1.levels = { ...shape.developed };
    c1.stock = res(900, 900, 900);
    c1.units = { [shape.attacker]: 40, [shape.carrier]: 5 };
    // An owned, weak, tagged city is the nearest stranger.
    const near = game.islands.find((i) => i.kind !== "home" && i.kind !== "crown")!;
    const crowned = colonyOf(shape, "c21", "p2", near.id, 0, { [shape.defender]: 1 });
    crowned.tag = "crown";
    game.cities.push(crowned);
    weakIntel(game, shape, "c21", 1);
    for (const version of botVersions("rusher")) {
      const rusher = (): SeatAgent =>
        createBotVersion("rusher", version, { seat: "p1", seed: 11, strict: true, hints });
      // Three rounds leave no room for target reads: a city it could not read is not spied blind.
      // oxlint-disable-next-line no-await-in-loop -- one version at a time on one fake game
      const blind = await playTurn(rusher(), game, "p1", { maxRounds: 3 });
      noViolations(game);
      expect(callsTo(blind, "view_city").filter((c) => c["city"] === "c21")).toEqual([]);
      expect(callsTo(blind, "spy")).toEqual([]);

      // oxlint-disable-next-line no-await-in-loop -- one version at a time on one fake game
      const log = await playTurn(rusher(), game, "p1");
      noViolations(game);
      for (const tool of ["spy", "attack"] as const) {
        expect(callsTo(log, tool).filter((c) => c["to"] === "c21")).toEqual([]);
      }
    }

    // The opportunist does not betray it either, even as a friend's weakest city.
    const prm = opportunistParams(streamOf(11, "p1", "opportunist", "params"));
    game.t = prm.betrayDay * DAY + 3600;
    game.relations.set("p1", [{ player: "p2", kind: "pact", until: null }]);
    game.intel.delete("p1|c2");
    const opp = createBot("opportunist", { seat: "p1", seed: 11, strict: true, hints });
    const betrayal = await playTurn(opp, game, "p1");
    noViolations(game);
    for (const tool of ["spy", "attack"] as const) {
      expect(callsTo(betrayal, tool).filter((c) => c["to"] === "c21")).toEqual([]);
    }
  });

  test.each([...botLabels()])(
    "%s: a besieged own city builds, recruits and sends nothing",
    async (label) => {
      const hints: StrategyHints = { settleOrder: [], avoidTags: [], blockedExt: ["siege"] };
      const game = shape.game();
      game.t = 3 * DAY + 3600;
      const c1 = game.city("c1");
      c1.levels = { ...shape.developed };
      c1.stock = res(900, 900, 900);
      c1.units = {
        [shape.attacker]: 40,
        [shape.carrier]: 5,
        [shape.defender]: 20,
        [shape.founder]: 1,
      };
      c1.ext = { siege: { by: "p2", endsAt: [game.t + 3600, "D4 02:00"] } };
      const c20 = colonyOf(shape, "c20", "p1", c1.island, 1, {});
      c20.stock = res(900, 900, 900);
      game.cities.push(c20);
      weakIntel(game, shape, "c2", 1);
      game.relations.set("p1", [{ player: "p2", kind: "ally", until: null }]);
      game.incoming.set("p1", [
        {
          id: "m0k4qz",
          kind: "attack",
          from: "c2",
          by: "p2",
          foe: "p1",
          to: "c20",
          depart: pair(game.t - 1000),
          arrive: pair(game.t + 9000),
        },
      ]);
      const b = botFromLabel(label, { seat: "p1", seed: 11, strict: true, hints });
      if (b === null) throw new Error(`${label} is not registered`);
      const log = await playTurn(b, game, "p1");
      noViolations(game);
      for (const tool of ["build", "recruit", "cancel_queue"] as const) {
        expect(callsTo(log, tool).filter((c) => c["city"] === "c1")).toEqual([]);
      }
      for (const tool of MOVES) {
        expect(callsTo(log, tool).filter((c) => c["from"] === "c1")).toEqual([]);
      }
      // The other city still plays.
      const c20Calls = [...callsTo(log, "build"), ...callsTo(log, "recruit")];
      expect(c20Calls.some((c) => c["city"] === "c20")).toBe(true);
      expect(log.endedBy).toBe("end_turn");
    },
  );

  test("turtle recruits max defenders and asks allies for support on an incoming attack", async () => {
    const game = shape.game();
    game.t = 70000;
    const c1 = game.city("c1");
    c1.levels = { ...shape.developed };
    c1.stock = res(600, 600, 600);
    game.relations.set("p1", [{ player: "p3", kind: "ally", until: null }]);
    game.incoming.set("p1", [
      {
        id: "m0k4qz",
        kind: "attack",
        from: "c2",
        by: "p2",
        foe: "p1",
        to: "c1",
        depart: pair(game.t - 1000),
        arrive: pair(game.t + 5000),
      },
    ]);
    const log = await playTurn(bot("turtle"), game, "p1");
    noViolations(game);
    expect(callsTo(log, "attack")).toEqual([]);
    const recruits = callsTo(log, "recruit");
    expect(recruits[0]).toEqual({ city: "c1", orders: [{ unit: shape.defender, count: "max" }] });
    const msgs = callsTo(log, "send_message");
    expect(msgs.length).toBe(1);
    expect(msgs[0]!["to"]).toEqual(["p3"]);
    expect(String(msgs[0]!["text"])).toContain("c1");

    // The same attack is answered once: the next turn neither recruits max nor writes again.
    game.t += 600;
    const again = await playTurn(bot("turtle"), game, "p1", { turn: 2 });
    expect(callsTo(again, "send_message")).toEqual([]);
    expect(callsTo(again, "recruit").filter((r) => JSON.stringify(r).includes('"max"'))).toEqual(
      [],
    );
  });

  test("turtle cancels its newest queued build item by number when it cannot afford a defender", async () => {
    const game = shape.game();
    game.t = 70000;
    const c1 = game.city("c1");
    c1.levels = { ...shape.developed };
    c1.stock = res(0, 0, 0);
    const [b0, b1] = [game.rules.buildings[0]!.id, game.rules.buildings[1]!.id];
    c1.build = [
      { item: 7, building: b0, level: 6, start: game.t - 100, end: game.t + 5000 },
      { item: 8, building: b1, level: 5, start: game.t + 5000, end: game.t + 9000 },
    ];
    c1.itemSeq = 8;
    game.incoming.set("p1", [
      {
        id: "m0k4qz",
        kind: "attack",
        from: "c2",
        by: "p2",
        foe: "p1",
        to: "c1",
        depart: pair(game.t - 1000),
        arrive: pair(game.t + 5000),
      },
    ]);
    const log = await playTurn(bot("turtle"), game, "p1");
    noViolations(game);
    const cancels = callsTo(log, "cancel_queue");
    expect(cancels).toEqual([{ city: "c1", item: 8 }]);
    const order = log.calls.map((c) => c.tool);
    expect(order.indexOf("cancel_queue")).toBeLessThan(order.indexOf("recruit"));
  });

  test("turtle tries its max defenders again on the next wake when the city could not recruit", async () => {
    const game = shape.game();
    game.t = 70000;
    const c1 = game.city("c1");
    c1.levels = { ...shape.developed };
    c1.stock = res(600, 600, 600);
    // The defenders' recruit queue is full.
    const queue = game.rules.units.find((u) => u.id === shape.defender)!.queue;
    const max = game.rules.queues.recruit.find((q) => q.id === queue)!.maxBatches;
    c1.recruit[queue] = upTo(max).map((i) => ({
      item: i,
      unit: shape.defender,
      count: 1,
      start: game.t - 100,
      end: game.t + 3000 * i,
    }));
    c1.itemSeq = max;
    game.relations.set("p1", [{ player: "p3", kind: "ally", until: null }]);
    game.incoming.set("p1", [
      {
        id: "m0k4qz",
        kind: "attack",
        from: "c2",
        by: "p2",
        foe: "p1",
        to: "c1",
        depart: pair(game.t - 1000),
        arrive: pair(game.t + 9000),
      },
    ]);
    const b = bot("turtle");
    const first = await playTurn(b, game, "p1");
    noViolations(game);
    expect(callsTo(first, "recruit")).toEqual([]);
    expect(callsTo(first, "send_message").length).toBe(1);

    // A batch is done: the queue has room, and the attack has not landed yet.
    game.t += 3000;
    c1.recruit[queue] = (c1.recruit[queue] ?? []).slice(1);
    const second = await playTurn(b, game, "p1", { turn: 2 });
    noViolations(game);
    expect(callsTo(second, "recruit")[0]).toEqual({
      city: "c1",
      orders: [{ unit: shape.defender, count: "max" }],
    });
    // The allies were asked once.
    expect(callsTo(second, "send_message")).toEqual([]);
  });

  test("turtle asks alliance members for support, not pact partners", async () => {
    const game = shape.game();
    game.t = 70000;
    game.city("c1").levels = { ...shape.developed };
    game.relations.set("p1", [
      { player: "p4", kind: "pact", until: null },
      { player: "p3", kind: "ally", until: null },
    ]);
    game.incoming.set("p1", [
      {
        id: "m0k4qz",
        kind: "attack",
        from: "c2",
        by: "p2",
        foe: "p1",
        to: "c1",
        depart: pair(game.t - 1000),
        arrive: pair(game.t + 9000),
      },
    ]);
    const log = await playTurn(bot("turtle"), game, "p1");
    expect(callsTo(log, "send_message").map((m) => m["to"])).toEqual([["p3"]]);

    // With pact partners only, nobody is asked.
    const lonely = shape.game();
    lonely.t = 70000;
    lonely.relations.set("p1", [{ player: "p4", kind: "pact", until: null }]);
    lonely.incoming.set("p1", game.incoming.get("p1")!);
    expect(callsTo(await playTurn(bot("turtle"), lonely, "p1"), "send_message")).toEqual([]);
  });

  test("turtle reads its threatened city first when it cannot read them all", async () => {
    const game = shape.game();
    game.t = 70000;
    const c1 = game.city("c1");
    c1.levels = { ...shape.developed };
    game.cities.push(colonyOf(shape, "c20", "p1", c1.island, 1, {}));
    // The threatened colony has a busy build queue, which used to put it last.
    const near = game.islands.find((i) => i.kind !== "home" && i.kind !== "crown")!;
    const threatened = colonyOf(shape, "c21", "p1", near.id, 0, {});
    threatened.stock = res(600, 600, 600);
    threatened.build = [0, 1, 2].map((i) => ({
      item: i + 1,
      building: game.rules.roles.storage,
      level: shape.developed[game.rules.roles.storage]! + i + 1,
      start: game.t,
      end: game.t + 3600 * (i + 1),
    }));
    threatened.itemSeq = 3;
    game.cities.push(threatened);
    game.incoming.set("p1", [
      {
        id: "m0k4qz",
        kind: "attack",
        from: "c2",
        by: "p2",
        foe: "p1",
        to: "c21",
        depart: pair(game.t - 1000),
        arrive: pair(game.t + 9000),
      },
    ]);
    // 12 calls for the turn: room for a single city view.
    const log = await playTurn(bot("turtle"), game, "p1", { perWake: 12 });
    noViolations(game);
    expect(callsTo(log, "view_city")).toEqual([{ city: "c21" }]);
    expect(callsTo(log, "recruit")[0]).toEqual({
      city: "c21",
      orders: [{ unit: shape.defender, count: "max" }],
    });
  });

  test("expander accepts every pact and one alliance while it has none", async () => {
    const free = shape.game();
    offerTwoAlliancesAndAPact(free);
    expect(callsTo(await playTurn(bot("expander"), free, "p1"), "answer_proposal")).toEqual([
      { id: "q0000a", accept: true },
      { id: "q0000b", accept: true },
      { id: "q0000c", accept: false },
    ]);
    const allied = shape.game();
    offerTwoAlliancesAndAPact(allied);
    allied.alliance.set("p1", "a1");
    allied.alliance.set("p5", "a1");
    allied.relations.set("p1", [{ player: "p5", kind: "ally", until: null }]);
    expect(callsTo(await playTurn(bot("expander"), allied, "p1"), "answer_proposal")).toEqual([
      { id: "q0000a", accept: false },
      { id: "q0000b", accept: true },
      { id: "q0000c", accept: false },
    ]);
  });

  test("turtle accepts every alliance and pact proposal", async () => {
    const game = shape.game();
    game.t = 5000;
    game.proposals.push(
      {
        id: "q0000a",
        from: "p2",
        to: "p1",
        kind: "alliance",
        name: "North",
        text: "join",
        expires: pair(40000),
      },
      {
        id: "q0000b",
        from: "p3",
        to: "p1",
        kind: "pact",
        name: null,
        text: "peace",
        expires: pair(40000),
      },
    );
    const log = await playTurn(bot("turtle"), game, "p1");
    expect(callsTo(log, "answer_proposal")).toEqual([
      { id: "q0000a", accept: true },
      { id: "q0000b", accept: true },
    ]);
  });

  test("opportunist proposes to its neighbours on day 1 and pays a tribute", async () => {
    const game = shape.game();
    game.t = 600;
    const log = await playTurn(bot("opportunist"), game, "p1");
    noViolations(game);
    const proposals = callsTo(log, "propose_alliance");
    expect(proposals.length).toBeGreaterThanOrEqual(1);
    expect(proposals.length).toBeLessThanOrEqual(game.rules.diplomacy.maxOpenProposals);
    expect(proposals[0]!["to"]).toBe("p2");
    for (const p of proposals) expect(p["until"]).toBeUndefined();
    const tributes = callsTo(log, "send_resources");
    expect(tributes.length).toBe(1);
    expect(tributes[0]!["to"]).toBe("c2");

    // Day 1 is done once: no new proposals the next turn.
    game.t += 7200;
    const again = await playTurn(bot("opportunist"), game, "p1", { turn: 2 });
    expect(callsTo(again, "propose_alliance")).toEqual([]);
  });

  test("opportunist records its allies in its notes", async () => {
    const game = shape.game();
    game.t = 3000;
    game.relations.set("p1", [{ player: "p2", kind: "ally", until: null }]);
    await playTurn(bot("opportunist"), game, "p1");
    const memory = parseMemory(game.notes.get("p1") ?? "", "opportunist");
    expect(memory.m).toContain("ally p2 since D1");
    expect(game.notes.get("p1")).toContain("ally p2 since D1");
  });

  test("opportunist attacks an ally on its seeded day, not before", async () => {
    const seed = 11;
    const prm = opportunistParams(streamOf(seed, "p1", "opportunist", "params"));
    expect(prm.betrayDay).toBeGreaterThanOrEqual(2);
    expect(prm.betrayDay).toBeLessThanOrEqual(4);
    const before = alliedPair(shape, prm.betrayDay - 1);
    const quiet = await playTurn(bot("opportunist", "p1", seed), before, "p1");
    expect(callsTo(quiet, "attack")).toEqual([]);

    const game = alliedPair(shape, prm.betrayDay);
    const log = await playTurn(bot("opportunist", "p1", seed), game, "p1");
    noViolations(game);
    const msgs = callsTo(log, "send_message");
    expect(msgs).toContainEqual({ to: ["p2"], text: "we remain friends" });
    const attacks = callsTo(log, "attack");
    expect(attacks.length).toBe(1);
    expect(attacks[0]!["to"]).toBe("c2");
    // The message goes first, and the bot does not leave the alliance before the betrayal lands.
    const tools = log.calls.map((c) => c.tool);
    expect(tools.indexOf("send_message")).toBeLessThan(tools.indexOf("attack"));
    expect(callsTo(log, "leave_alliance")).toEqual([]);
    const memory = parseMemory(game.notes.get("p1") ?? "", "opportunist");
    expect(memory.m.some((l) => l.startsWith("betray p2 "))).toBe(true);
  });

  test("opportunist does not betray when it is not in the top 2", async () => {
    const seed = 11;
    const prm = opportunistParams(streamOf(seed, "p1", "opportunist", "params"));
    const game = shape.game();
    game.t = prm.betrayDay * DAY + 3600;
    game.city("c1").levels = { ...shape.developed };
    game.city("c1").units = { [shape.attacker]: 40, [shape.carrier]: 3 };
    game.relations.set("p1", [{ player: "p2", kind: "ally", until: null }]);
    game.ranks.set("p1", 3);
    game.ranks.set("p3", 1);
    const log = await playTurn(bot("opportunist", "p1", seed), game, "p1");
    expect(callsTo(log, "attack")).toEqual([]);
    // Nor does it spend gold spying on its friends.
    expect(callsTo(log, "spy")).toEqual([]);
  });

  test("opportunist spies a pact partner it cannot see, then betrays it on the report", async () => {
    const seed = 11;
    const prm = opportunistParams(streamOf(seed, "p1", "opportunist", "params"));
    // Two days before its betrayal day it does not spy yet.
    const early = pactPair(shape, prm.betrayDay - 2);
    expect(callsTo(await playTurn(bot("opportunist", "p1", seed), early, "p1"), "spy")).toEqual([]);

    const game = pactPair(shape, prm.betrayDay);
    const b = bot("opportunist", "p1", seed);
    const first = await playTurn(b, game, "p1");
    noViolations(game);
    expect(callsTo(first, "spy").map((s) => s["to"])).toEqual(["c2"]);
    expect(callsTo(first, "attack")).toEqual([]);

    const spy = game.moves.find((m) => m.kind === "spy" && m.to === "c2")!;
    advance(game, spy.arrive);
    const second = await playTurn(b, game, "p1", { turn: 2 });
    noViolations(game);
    expect(callsTo(second, "send_message")).toContainEqual({
      to: ["p2"],
      text: "we remain friends",
    });
    expect(callsTo(second, "attack").map((a) => a["to"])).toEqual(["c2"]);
    expect(callsTo(second, "spy")).toEqual([]);
  });

  test("opportunist leaves a pact partner alone when the report shows a strong city", async () => {
    const seed = 11;
    const prm = opportunistParams(streamOf(seed, "p1", "opportunist", "params"));
    const game = shape.game();
    game.t = prm.betrayDay * DAY + 3600;
    const c1 = game.city("c1");
    c1.levels = { ...shape.developed };
    c1.units = { [shape.attacker]: 40, [shape.carrier]: 3 };
    game.relations.set("p1", [{ player: "p2", kind: "pact", until: null }]);
    weakIntel(game, shape, "c2", 400);
    const log = await playTurn(bot("opportunist", "p1", seed), game, "p1");
    expect(callsTo(log, "attack")).toEqual([]);
    // Its intel is fresh: no need to spy again.
    expect(callsTo(log, "spy")).toEqual([]);
  });
});

test("rusher parameters keep a margin of at least 1.5x", () => {
  for (let seed = 0; seed < 200; seed += 1) {
    const prm = rusherParams(streamOf(seed, "p1", "rusher", "params"));
    expect(prm.marginPm).toBeGreaterThanOrEqual(1500);
  }
});

test("opportunist betrayal days span D3..D5", () => {
  const days = new Set<number>();
  for (let seed = 0; seed < 200; seed += 1) {
    days.add(opportunistParams(streamOf(seed, "p1", "opportunist", "params")).betrayDay);
  }
  expect([...days].toSorted((a, b) => a - b)).toEqual([2, 3, 4]);
});

/** Six turtle turns two hours apart with full stock; the buildings it queued. */
async function turtleBuilds(game: FakeGame): Promise<string[]> {
  game.t = 2 * DAY;
  game.city("c1").stock = res(3000, 3000, 3000);
  const all: string[] = [];
  const b = bot("turtle");
  await inSequence(upTo(6), async (turn) => {
    const log = await playTurn(b, game, "p1", { turn });
    for (const call of callsTo(log, "build")) all.push(...strs(call["buildings"]));
    game.t += 7200;
    for (const c of game.cities) {
      for (const item of c.build.filter((x) => x.end <= game.t)) {
        c.levels[item.building] = (c.levels[item.building] ?? 0) + 1;
      }
      c.build = c.build.filter((x) => x.end > game.t);
      c.stock = res(3000, 3000, 3000);
    }
  });
  return all;
}

test("sandbox shape: a turtle builds no wall, a perfidia-shaped turtle does", async () => {
  const run = turtleBuilds;
  expect(await run(perfidiaGame(6))).toContain("wall");
  const sandboxBuilds = await run(sandboxGame(6));
  expect(sandboxBuilds.length).toBeGreaterThan(0);
  for (const b of sandboxBuilds)
    expect(sandboxGame(6).rules.buildings.some((x) => x.id === b)).toBe(true);
});
