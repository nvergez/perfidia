// Fixture behaviours of conqueror@2 (docs/architecture.md §11.2) on rules shaped like perfidia-1: its
// victim by expected value (not the player with the fewest cities, a rival bloc in a domination
// countdown first, the victim an ally names, a city lost to retake), founding past four cities, a
// colony struck before capitals can fall, a train called off on fresher intel, spies held back when
// the own wakes would not see the day out, and its diplomacy (a war alliance proposed to a strong
// neighbour, answers, its victim told to its allies, support for an ally's city). Its play on real
// matches is tested in `sim` (`conqueror2.test.ts`).

import { describe, expect, test } from "bun:test";
import type {
  Briefing,
  CityId,
  IslandId,
  JsonObject,
  PlayerId,
  RoundInput,
  SeatAgent,
  ToolResult,
} from "@perfidia/protocol";
import {
  advance,
  callsTo,
  capital,
  counts,
  perfidiaGame,
  playTurn,
  res,
  type FakeGame,
  type FCity,
} from "./fixtures.test.ts";
import { fmtTime } from "./kit.ts";
import { encodeMemory, parseMemory, type Memory } from "./memory.ts";
import { botLabel, createBotVersion } from "./registry.ts";

const DAY = 86400;
const pair = (t: number): [number, string] => [t, fmtTime(t)];

/** Levels where every unit of the perfidia-1 fixture can be recruited. */
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
/** The config numbers the perfidia-1 hints point at. */
const CONFIG: JsonObject = {
  time: { capitalImmunityEnd: 2 * DAY },
  economy: { baseDefense: { a: 0, b: 20, c: 50 } },
  combat: { wallPmPerLevel: 50, moralePmPerCity: 100, moraleFloorPm: 700 },
};
/** Islands of the fixture: p1's home, backyard, frontier and inner island; p2's backyard. */
const HOME: IslandId = "i2";
const FRONTIER: IslandId = "i4";
const INNER: IslandId = "i5";
const FAR: IslandId = "i7";

function bot(seed = 11): SeatAgent {
  return createBotVersion("conqueror", 2, { seat: "p1", seed, strict: true });
}

function game(): FakeGame {
  const g = perfidiaGame(6);
  Object.assign(g.info.config, structuredClone(CONFIG));
  return g;
}

function memoryOf(g: FakeGame): Memory {
  return parseMemory(g.notes.get("p1") ?? "", "conqueror");
}

/** Notes of a conqueror@2 with the flags `x`. */
function notesWith(x: Record<string, number>): string {
  return encodeMemory({ s: "conqueror", h: null, f: {}, m: [], x, k: [] }, 4000);
}

/** A city of `owner` on `island` (slot `slot`), not a capital. */
function colony(
  id: CityId,
  owner: PlayerId,
  island: IslandId,
  slot: number,
  units: Record<string, number>,
): FCity {
  const c = capital(id, owner, island, DEVELOPED, res(300, 300, 300), units);
  c.slot = slot;
  c.capitalOf = null;
  return c;
}

/** A spy report of p1 on `city`, `ago` seconds old: `units` at home, and the levels it saw. */
function spied(
  g: FakeGame,
  city: CityId,
  units: Record<string, number>,
  buildings: Record<string, number> = { hall: 1 },
  ago = 3600,
): void {
  g.intel.set(`p1|${city}`, {
    type: "spy_report",
    at: g.t - ago,
    data: { report: "r00001", city, buildings, units: { home: units } },
  });
}

/** p1's capital with an army, founders and the carriers for all of it. */
function armed(g: FakeGame, units: Record<string, number>): void {
  const c1 = g.city("c1");
  c1.levels = { ...DEVELOPED };
  c1.stock = res(5000, 5000, 5000);
  c1.units = { ...units };
}

const ARMY = { raider: 80, guard: 20, transport: 20, settler: 2 };

/** Every island full: no free slot, so founders have nowhere to found a city. */
function noFreeSlots(g: FakeGame): void {
  for (const [i, isl] of g.islands.entries()) {
    const n = g.cities.filter((c) => c.island === isl.id).length;
    g.islands[i] = { ...isl, slots: n };
  }
}

/** Capitals of `seats` spied with a garrison no army of the fixture breaks. */
function fortified(g: FakeGame, seats: readonly number[]): void {
  for (const n of seats) spied(g, `c${n}`, { guard: 2000 }, { hall: 10, wall: 10 });
}

/** `agent` with its briefings patched (countdowns in `ext`, messages, events), as the gateway would show them. */
function briefed(agent: SeatAgent, patch: (b: Briefing) => Briefing): SeatAgent {
  return {
    label: agent.label,
    round: (input: RoundInput) => agent.round({ ...input, briefing: patch(input.briefing) }),
  };
}

/** The leaderboard of the fake game with these scores (rank by score). */
function scored(g: FakeGame, scores: Record<string, number>): void {
  const respond = g.respond.bind(g);
  g.respond = (seat, c): ToolResult => {
    const r = respond(seat, c);
    if (c.tool !== "leaderboard" || !r.ok) return r;
    const order = g.players.toSorted((a, b) => (scores[b] ?? 100) - (scores[a] ?? 100));
    const standings = g.players.map((p) => ({
      rank: order.indexOf(p) + 1,
      player: p,
      score: scores[p] ?? 100,
      parts: { cityPoints: scores[p] ?? 100 },
      cities: g.cities.filter((x) => x.owner === p).length,
      alive: true,
      alliance: g.alliance.get(p) ?? null,
      relations: [],
    }));
    return { ...r, data: { standings, ext: {} } };
  };
}

const founders = (a: Record<string, unknown>): number => counts(a["units"])["settler"] ?? 0;

/** Day 3, p1 armed; weak colonies of p3 (on p1's frontier) and p4 (on its inner island), spied. */
function twoColonies(): FakeGame {
  const g = game();
  g.t = 2 * DAY + 3600;
  armed(g, ARMY);
  g.cities.push(colony("c20", "p3", FRONTIER, 0, { guard: 2 }));
  g.cities.push(colony("c21", "p4", INNER, 0, { guard: 2 }));
  spied(g, "c20", { guard: 2 });
  spied(g, "c21", { guard: 2 });
  fortified(g, [2, 3, 4, 5, 6]);
  return g;
}

/** p1's capital and a colony 13200 s from p2's colony c20 (the capital is 11818 s away). */
function trainGame(): FakeGame {
  const g = game();
  g.t = g.rules.time.attackFrom + DAY;
  g.islands.push({ id: "i90", kind: "inner", x: 180, y: -300, richnessPm: 1000, slots: 1 });
  armed(g, { raider: 40, settler: 2, transport: 4, guard: 10 });
  g.cities.push(colony("c30", "p1", "i90", 0, { raider: 250, transport: 13 }));
  g.cities.push(colony("c20", "p2", FAR, 0, { guard: 100 }));
  spied(g, "c20", { guard: 100 }, { hall: 3, wall: 0 });
  fortified(g, [2, 3, 4, 5, 6]);
  noFreeSlots(g);
  return g;
}

/**
 * The first turn of a train on c20: the helpers leave, with a spy to check the defense before the
 * founders' wave leaves; then the game is advanced to the timed launch.
 */
async function planTrain(g: FakeGame, b: SeatAgent): Promise<void> {
  const t0 = g.t;
  const first = await playTurn(b, g, "p1", { notes: notesWith({ av: 2, ac: 1 }) });
  expect(g.violations).toEqual([]);
  expect(callsTo(first, "attack")).toEqual([
    { from: "c30", to: "c20", units: { raider: 250, transport: 13 } },
  ]);
  expect(callsTo(first, "spy").some((s) => s["to"] === "c20")).toBe(true);
  expect(memoryOf(g).x).toMatchObject({ at: 20, aw: t0 + 13260, ap: t0 });
  expect(memoryOf(g).x["ae"]).toBeGreaterThan(2000);
  expect(first.wakeAt).toBe(t0 + 13260 - 11818);
  advance(g, first.wakeAt!);
}

/** Day 3 noon, p1 armed, p3's colony on p1's frontier never spied, `left` own wakes left today. */
function unscouted(left: number): FakeGame {
  const g = game();
  g.t = 2 * DAY + 12 * 3600;
  armed(g, ARMY);
  g.cities.push(colony("c20", "p3", FRONTIER, 0, { guard: 2 }));
  g.budget.ownWakesLeft = left;
  return g;
}

/** `twoColonies`, with p1 allied to p6. */
function alliedColonies(): FakeGame {
  const g = twoColonies();
  g.relations.set("p1", [{ player: "p6", kind: "ally", until: null }]);
  g.alliance.set("p1", "a1");
  g.alliance.set("p6", "a1");
  return g;
}

/** p3's colony on p1's frontier: 30 guards, which 200 raiders break; a free slot at home. */
function colonyGame(): FakeGame {
  const g = game();
  g.t = 2 * DAY + 3600;
  armed(g, { ...ARMY, raider: 200, transport: 30 });
  g.cities.push(colony("c20", "p3", FRONTIER, 0, { guard: 30 }));
  spied(g, "c20", { guard: 30 });
  fortified(g, [2, 3, 4, 5, 6]);
  return g;
}

/**
 * p2's colony on its backyard (20 guards), 11818 s from p1's capital; p2's capital, 4800 s from it,
 * is spied with 400 guards and `carriers`: half of them land before the waves when it has carriers.
 */
function strikeGame(carriers: number): FakeGame {
  const g = game();
  g.t = 2 * DAY + 3600;
  armed(g, { ...ARMY, raider: 150, transport: 30 });
  g.cities.push(colony("c20", "p2", FAR, 0, { guard: 20 }));
  spied(g, "c20", { guard: 20 });
  spied(g, "c2", carriers > 0 ? { guard: 400, transport: carriers } : { guard: 400 });
  noFreeSlots(g);
  return g;
}

describe("conqueror@2 (perfidia-1 shape)", () => {
  test("it is the latest conqueror; conqueror@1 stays registered", () => {
    expect(botLabel("conqueror")).toBe("bot:conqueror@2");
    expect(bot().label).toBe("bot:conqueror@2");
    expect(createBotVersion("conqueror", 1, { seat: "p1", seed: 1 }).label).toBe("bot:conqueror@1");
  });

  test("its victim is the best value for the cost, not the player with the fewest cities", async () => {
    const g = game();
    g.t = 2 * DAY + 3600;
    armed(g, ARMY);
    // p2 has its capital only, behind a strong garrison; p3 a weak colony on p1's frontier.
    spied(g, "c2", { guard: 300 }, { hall: 6, wall: 4 });
    g.cities.push(colony("c20", "p3", FRONTIER, 0, { guard: 2 }));
    spied(g, "c20", { guard: 2 });
    fortified(g, [3, 4, 5, 6]);
    await playTurn(bot(), g, "p1");
    expect(g.violations).toEqual([]);
    const m = memoryOf(g);
    expect(m.x["av"]).toBe(3);
    expect(m.m.some((l) => l.startsWith("victim p3") && l.includes("c20"))).toBe(true);
    // conqueror@1 goes for the player with the fewest cities.
    const old = game();
    old.t = g.t;
    armed(old, ARMY);
    old.cities.push(colony("c20", "p3", FRONTIER, 0, { guard: 2 }));
    await playTurn(
      createBotVersion("conqueror", 1, { seat: "p1", seed: 11, strict: true }),
      old,
      "p1",
    );
    expect(memoryOf(old).x["av"]).not.toBe(3);
  });

  test("a bloc running a domination countdown it is not in weighs more: stop the leader", async () => {
    const calm = twoColonies();
    await playTurn(bot(), calm, "p1");
    expect(memoryOf(calm).x["av"]).toBe(3);

    const g = twoColonies();
    const countdown = {
      key: "a1",
      members: ["p4", "p6"],
      cities: 12,
      need: 12,
      ends: pair(g.t + DAY),
    };
    await playTurn(
      briefed(bot(), (b) => ({ ...b, ext: { ...b.ext, countdowns: [countdown] } })),
      g,
      "p1",
    );
    const m = memoryOf(g);
    expect(m.x["av"]).toBe(4);
    expect(m.m.some((l) => l.startsWith("victim p4") && l.includes("countdown"))).toBe(true);
  });

  test("it retakes a city it lost first", async () => {
    const g = game();
    g.t = 2 * DAY + 3600;
    armed(g, ARMY);
    g.cities.push(colony("c20", "p3", FRONTIER, 0, { guard: 2 }));
    g.cities.push(colony("c21", "p4", INNER, 0, { guard: 6 }));
    spied(g, "c20", { guard: 2 });
    spied(g, "c21", { guard: 6 });
    fortified(g, [2, 3, 4, 5, 6]);
    const lost = { type: "city_conquered", city: "c21", from: "p1", to: "p4" };
    await playTurn(
      briefed(bot(), (b) => ({ ...b, events: [...b.events, lost] })),
      g,
      "p1",
    );
    const m = memoryOf(g);
    expect(m.x["av"]).toBe(4);
    expect(m.x["loc21"]).toBe(g.t);
    expect(m.m.some((l) => l.startsWith("victim p4") && l.includes("retake"))).toBe(true);
  });

  test("it keeps founding past four cities while a free slot is in reach", async () => {
    const g = game();
    g.t = DAY + 12 * 3600;
    armed(g, { guard: 20, transport: 6, settler: 1 });
    g.cities.push(colony("c20", "p1", HOME, 1, { guard: 4 }));
    g.cities.push(colony("c21", "p1", "i3", 0, { guard: 4 }));
    g.cities.push(colony("c22", "p1", FRONTIER, 0, { guard: 4 }));
    g.cities.push(colony("c23", "p1", INNER, 0, { guard: 4 }));
    const log = await playTurn(bot(), g, "p1");
    expect(g.violations).toEqual([]);
    const found = callsTo(log, "found_city");
    expect(found.length).toBe(1);
    // The frontier's second slot, the last free one around p1's home.
    expect(found[0]).toMatchObject({ from: "c1", island: FRONTIER });
    // conqueror@1 stops at four cities.
    const log1 = await playTurn(
      createBotVersion("conqueror", 1, { seat: "p1", seed: 11, strict: true }),
      g,
      "p1",
    );
    expect(callsTo(log1, "found_city")).toEqual([]);
  });

  test("its founders found a city on a free slot worth more than a conquest, and strike once none is left", async () => {
    const g = colonyGame();
    const log = await playTurn(bot(), g, "p1");
    expect(g.violations).toEqual([]);
    expect(callsTo(log, "attack")).toEqual([]);
    expect(callsTo(log, "found_city").length).toBeGreaterThan(0);
    // No free slot left: the same colony is worth its founders.
    const full = colonyGame();
    noFreeSlots(full);
    const struck = await playTurn(bot(), full, "p1");
    expect(full.violations).toEqual([]);
    const sent = callsTo(struck, "attack").filter((a) => a["to"] === "c20");
    expect(sent.some((a) => founders(a) > 0)).toBe(true);
  });

  test("it counts the support its victim's cities on other islands can ship over before the waves land", async () => {
    const shipped = strikeGame(10);
    const log = await playTurn(bot(), shipped, "p1");
    expect(shipped.violations).toEqual([]);
    expect(callsTo(log, "attack").filter((a) => a["to"] === "c20")).toEqual([]);
    // Without carriers its capital's guards cannot cross: the colony is struck.
    const stuck = strikeGame(0);
    const struck = await playTurn(bot(), stuck, "p1");
    expect(stuck.violations).toEqual([]);
    expect(callsTo(struck, "attack").some((a) => a["to"] === "c20" && founders(a) > 0)).toBe(true);
  });

  test("it strikes a weak colony before capitals can fall, founders in the leading wave", async () => {
    const g = game();
    g.t = g.rules.time.attackFrom + 2 * 3600;
    expect(g.t).toBeLessThan(2 * DAY);
    armed(g, ARMY);
    g.cities.push(colony("c20", "p2", FRONTIER, 0, { guard: 2 }));
    spied(g, "c20", { guard: 2 });
    noFreeSlots(g);
    const log = await playTurn(bot(), g, "p1");
    expect(g.violations).toEqual([]);
    const attacks = callsTo(log, "attack");
    expect(attacks.length).toBeGreaterThanOrEqual(2);
    expect(attacks.every((a) => a["to"] === "c20")).toBe(true);
    expect(founders(attacks[0]!)).toBe(2);
    expect(memoryOf(g).x).toMatchObject({ av: 2, ac: 1 });
  });

  describe("a train", () => {
    test("its founders' wave stays home when a fresher report shows twice the defense", async () => {
      const g = trainGame();
      const b = bot();
      await planTrain(g, b);
      spied(g, "c20", { guard: 300 }, { hall: 3, wall: 0 }, 600);
      const log = await playTurn(b, g, "p1", { turn: 2 });
      expect(g.violations).toEqual([]);
      expect(callsTo(log, "attack")).toEqual([]);
      const m = memoryOf(g);
      expect(m.x["at"]).toBeUndefined();
      expect(m.x["ae"]).toBeUndefined();
      expect(m.m.some((l) => l.startsWith("train c20 called off"))).toBe(true);
    });

    test("its founders' wave stays home past twice the defense planned on, even when the waves would still win", async () => {
      const g = trainGame();
      // Helpers strong enough to break even the larger garrison.
      g.city("c30").units = { raider: 400, transport: 20 };
      const b = bot();
      const first = await playTurn(b, g, "p1", { notes: notesWith({ av: 2, ac: 1 }) });
      expect(g.violations).toEqual([]);
      expect(callsTo(first, "attack")).toEqual([
        { from: "c30", to: "c20", units: { raider: 400, transport: 20 } },
      ]);
      const planned = memoryOf(g).x["ae"] ?? 0;
      advance(g, first.wakeAt!);
      // 240 guards: a defense above twice the one planned on, which 400 raiders still break.
      spied(g, "c20", { guard: 240 }, { hall: 3, wall: 0 }, 600);
      const log = await playTurn(b, g, "p1", { turn: 2 });
      expect(g.violations).toEqual([]);
      expect(callsTo(log, "attack")).toEqual([]);
      const called = memoryOf(g).m.find((l) => l.startsWith("train c20 called off"));
      expect(called).toContain(`vs D${planned}`);
    });

    test("it leaves as planned when the fresher report confirms the defense", async () => {
      const g = trainGame();
      const b = bot();
      await planTrain(g, b);
      spied(g, "c20", { guard: 100 }, { hall: 3, wall: 0 }, 600);
      const log = await playTurn(b, g, "p1", { turn: 2 });
      const attacks = callsTo(log, "attack");
      expect(attacks.length).toBeGreaterThan(0);
      expect(attacks.every((a) => a["from"] === "c1" && a["to"] === "c20")).toBe(true);
      expect(attacks.some((a) => founders(a) > 0)).toBe(true);
      expect(memoryOf(g).x["at"]).toBeUndefined();
    });
  });

  test("spies wait while the own wakes left would not see the day out", async () => {
    const rich = unscouted(12);
    const spies = callsTo(await playTurn(bot(), rich, "p1"), "spy");
    expect(spies.length).toBeGreaterThan(0);
    const poor = unscouted(2);
    expect(callsTo(await playTurn(bot(), poor, "p1"), "spy")).toEqual([]);
  });

  test("notes it cannot parse are read as empty memory and rewritten", async () => {
    const g = game();
    g.t = 3600;
    const log = await playTurn(bot(), g, "p1", { notes: "War plan: p3 first, then p4. {broken" });
    const notes = callsTo(log, "write_note");
    expect(notes.length).toBe(1);
    expect(notes[0]).toMatchObject({ mode: "replace" });
    expect(parseMemory(String(notes[0]!["text"]), "conqueror").s).toBe("conqueror");
  });

  describe("diplomacy", () => {
    test("it proposes a war alliance to the strongest near neighbour that is not its victim", async () => {
      const g = game();
      g.t = 2 * DAY + 3600;
      armed(g, ARMY);
      g.cities.push(colony("c20", "p3", FRONTIER, 0, { guard: 2 }));
      spied(g, "c20", { guard: 2 });
      fortified(g, [2, 3, 4, 5, 6]);
      scored(g, { p2: 200, p3: 500, p4: 300 });
      const log = await playTurn(bot(), g, "p1");
      expect(memoryOf(g).x["av"]).toBe(3);
      const proposals = callsTo(log, "propose_alliance");
      expect(proposals.length).toBe(1);
      expect(proposals[0]).toMatchObject({ to: "p4", kind: "alliance" });
      expect(String(proposals[0]!["text"])).toContain("p3");
      expect(memoryOf(g).x["dp"]).toBe(3);
      // Once a day.
      const again = await playTurn(bot(), g, "p1", { turn: 2 });
      expect(callsTo(again, "propose_alliance")).toEqual([]);
    });

    test("it proposes a pact instead when that neighbour has an alliance already", async () => {
      const g = game();
      g.t = 2 * DAY + 3600;
      armed(g, ARMY);
      g.cities.push(colony("c20", "p3", FRONTIER, 0, { guard: 2 }));
      spied(g, "c20", { guard: 2 });
      fortified(g, [2, 3, 4, 5, 6]);
      g.alliance.set("p4", "a1");
      g.alliance.set("p5", "a1");
      scored(g, { p2: 200, p3: 500, p4: 300 });
      const log = await playTurn(bot(), g, "p1");
      expect(callsTo(log, "propose_alliance")).toEqual([
        { to: "p4", kind: "pact", text: "Peace between us while I fight p3?" },
      ]);
    });

    test("pacts and one alliance from anyone but its victim", async () => {
      const g = game();
      g.t = 2 * DAY + 3600;
      armed(g, ARMY);
      g.cities.push(colony("c20", "p3", FRONTIER, 0, { guard: 2 }));
      spied(g, "c20", { guard: 2 });
      fortified(g, [2, 3, 4, 5, 6]);
      for (const [id, from, kind] of [
        ["q0000a", "p3", "alliance"],
        ["q0000b", "p2", "pact"],
        ["q0000c", "p4", "alliance"],
        ["q0000d", "p5", "alliance"],
      ] as const) {
        g.proposals.push({
          id,
          from,
          to: "p1",
          kind,
          name: kind === "alliance" ? "North" : null,
          text: "join",
          expires: pair(g.t + 40000),
        });
      }
      const log = await playTurn(bot(), g, "p1");
      expect(memoryOf(g).x["av"]).toBe(3);
      expect(callsTo(log, "answer_proposal")).toEqual([
        { id: "q0000a", accept: false },
        { id: "q0000b", accept: true },
        { id: "q0000c", accept: true },
        { id: "q0000d", accept: false },
      ]);
      // Allied: it proposes no other alliance.
      expect(callsTo(log, "propose_alliance")).toEqual([]);
    });

    test("it tells its ally its victim once, and weighs the victim an ally names", async () => {
      const g = alliedColonies();
      const b = bot();
      const log = await playTurn(b, g, "p1");
      expect(memoryOf(g).x["av"]).toBe(3);
      expect(callsTo(log, "send_message")).toEqual([
        { to: ["p6"], text: "war on p3: I am taking their cities. Join me." },
      ]);
      expect(callsTo(await playTurn(b, g, "p1", { turn: 2 }), "send_message")).toEqual([]);

      const named = alliedColonies();
      const msg: Briefing["msgs"][number] = {
        id: "g0000a",
        from: "p6",
        to: ["p1"],
        text: "war on p4: their colony c21 is weak.",
      };
      await playTurn(
        briefed(bot(), (br) => ({ ...br, msgs: [msg] })),
        named,
        "p1",
      );
      const m = memoryOf(named);
      expect(m.x).toMatchObject({ av: 4, jv: 4, jt: named.t });
    });

    test("it supports an ally's city under attack when its defenders land first", async () => {
      const g = game();
      g.t = DAY;
      armed(g, { guard: 40, transport: 10 });
      g.relations.set("p1", [{ player: "p2", kind: "ally", until: null }]);
      g.alliance.set("p1", "a1");
      g.alliance.set("p2", "a1");
      g.incoming.set("p1", [
        {
          id: "m0000a",
          kind: "attack",
          from: "c3",
          by: "p3",
          foe: "p2",
          to: "c2",
          depart: pair(g.t - 600),
          arrive: pair(g.t + 5 * 3600),
        },
      ]);
      const b = bot();
      const log = await playTurn(b, g, "p1");
      expect(g.violations).toEqual([]);
      const support = callsTo(log, "support");
      expect(support.length).toBe(1);
      expect(support[0]).toMatchObject({ from: "c1", to: "c2" });
      expect(counts(support[0]!["units"])["guard"]).toBe(13);
      // Answered once.
      expect(callsTo(await playTurn(b, g, "p1", { turn: 2 }), "support")).toEqual([]);
    });
  });
});
