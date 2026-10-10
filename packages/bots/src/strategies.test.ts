// Fixture behaviours of the four strategies (docs/architecture.md §11.2, T09 acceptance), each on
// rules shaped like perfidia-1 and like sandbox-1.

import { describe, expect, test } from "bun:test";
import type { MovementId, PlayerId } from "@perfidia/protocol";
import {
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
} from "./fixtures.test.ts";
import { fmtTime } from "./kit.ts";
import { parseMemory } from "./memory.ts";
import { createBot } from "./registry.ts";
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

function bot(strategy: BotStrategy, seat: PlayerId = "p1", seed = 11) {
  return createBot(strategy, { seat, seed, strict: true });
}

function noViolations(game: FakeGame): void {
  expect(game.violations).toEqual([]);
}

describe.each(SHAPES)("$name", (shape) => {
  test("expander queues economy first", async () => {
    const game = shape.game();
    const log = await playTurn(bot("expander"), game, "p1");
    noViolations(game);
    const builds = callsTo(log, "build");
    expect(builds.length).toBe(1);
    const items = strs(builds[0]!["buildings"]);
    const kit = game.rules.roles;
    const economy = new Set([
      kit.storage,
      kit.population,
      ...Object.values(kit.producers),
      ...game.rules.buildings.filter((b) => b.id !== kit.wall).map((b) => b.id),
    ]);
    expect(items.length).toBeGreaterThan(0);
    for (const b of items) expect(economy.has(b)).toBe(true);
    expect(callsTo(log, "attack")).toEqual([]);
    expect(log.endedBy).toBe("end_turn");
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
    const log = await playTurn(bot("rusher"), game, "p1");
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
    const log = await playTurn(bot("rusher"), game, "p1");
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
    const log = await playTurn(bot("rusher"), game, "p1");
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
    const log = await playTurn(bot("rusher"), game, "p1");
    expect(callsTo(log, "recall_troops")).toEqual([]);
  });

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
