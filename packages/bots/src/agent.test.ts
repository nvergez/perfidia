// The bot contract (docs/architecture.md §11.1, T09 acceptance): determinism, mid-match take-over
// with any notebook, instance-owned caches, protocol-valid calls within every cap, `{ok: false}`
// never throwing, every turn ending with `end_turn` and an in-range `wakeAt`, notes within the cap.

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  TOOL_ARGS,
  z,
  type Briefing,
  type PlayerId,
  type RoundInput,
  type ToolCall,
} from "@perfidia/protocol";
import {
  advance,
  callsTo,
  capital,
  clone,
  inSequence,
  perfidiaGame,
  playTurn,
  res,
  sandboxGame,
  str,
  strs,
  upTo,
  type FakeGame,
  type TurnLog,
} from "./fixtures.test.ts";
import { parseMemory } from "./memory.ts";
import { createBot } from "./registry.ts";
import { randInt, streamOf } from "./rng.ts";
import { BOT_STRATEGIES, type BotStrategy } from "./strategies/strategy.ts";

const DAY = 86400;
const GAMES = { perfidia: perfidiaGame, sandbox: sandboxGame } as const;
type GameName = keyof typeof GAMES;
const NAMES: GameName[] = ["perfidia", "sandbox"];
const STRATEGIES: BotStrategy[] = [...BOT_STRATEGIES];

function strict(strategy: BotStrategy, seat: PlayerId = "p1", seed = 5) {
  return createBot(strategy, { seat, seed, strict: true });
}

/** Asserts the end of a turn: `end_turn` last, `wakeAt` within the self-wake range of `t`. */
function endsWell(game: FakeGame, log: TurnLog, t: number): void {
  const { min, max } = game.rules.gateway.selfWake;
  expect(log.calls.at(-1)?.tool).toBe("end_turn");
  for (const c of log.calls) {
    if (c.tool !== "end_turn") continue;
    const args = TOOL_ARGS.end_turn.parse(c.args);
    expect(args.nextWakeIn).toBeUndefined();
    expect(args.wakeAt).toBeNumber();
    expect(args.wakeAt ?? -1).toBeGreaterThanOrEqual(t + min);
    expect(args.wakeAt ?? -1).toBeLessThanOrEqual(t + max);
  }
}

const ids = (g: FakeGame): Set<string> => new Set(g.rules.buildings.map((b) => b.id));

/** Plays `turns` turns of one bot, advancing the fake to each requested wake. */
async function campaign(name: GameName, strategy: BotStrategy, turns: number, seed = 5) {
  const game = GAMES[name](6);
  const bot = strict(strategy, "p1", seed);
  const logs: TurnLog[] = [];
  await inSequence(upTo(turns), async (turn) => {
    const t = game.t;
    const log = await playTurn(bot, game, "p1", { turn });
    expect(game.violations).toEqual([]);
    endsWell(game, log, t);
    logs.push(log);
    advance(game, log.wakeAt ?? t + 3600);
  });
  return { game, logs };
}

describe.each(NAMES)("%s shape", (name) => {
  test.each(STRATEGIES)(
    "%s: same inputs give the same outputs over a campaign",
    async (strategy) => {
      const a = await campaign(name, strategy, 25);
      const b = await campaign(name, strategy, 25);
      expect(JSON.stringify(b.logs)).toBe(JSON.stringify(a.logs));
      // The campaign is not idle: the bot builds and grows.
      expect(a.logs.some((l) => callsTo(l, "build").length > 0)).toBe(true);
    },
  );

  test.each(STRATEGIES)("%s: one instance replays a round identically", async (strategy) => {
    const game = GAMES[name](6);
    const input: RoundInput = {
      seat: "p1",
      turn: 1,
      round: 0,
      maxRounds: 8,
      maxCalls: 10,
      briefing: game.briefing("p1"),
      results: [],
    };
    const bot = strict(strategy);
    const first = await bot.round(clone(input));
    const second = await bot.round(clone(input));
    expect(second).toEqual(first);
  });

  const NOTEBOOKS: ((cap: number) => string)[] = [
    () => "",
    () => "My plan: befriend p2, then strike p3 at dawn. p4 lied to me on day 2.",
    (cap) => "remember the north. ".repeat(cap).slice(0, cap),
    (cap) => JSON.stringify({ v: 1, s: "x", pad: "y".repeat(cap) }).slice(0, cap),
    () => '{"v":1,"s":"rusher","h":null,"f":{},"m":[],"x":{"bt":3},"k":[]}',
    () => '{"v":1,"s":"expander","h":"deadbeef:6","f":{"i9":10},"m":[],"x":{},"k":[]}',
  ];

  test.each(STRATEGIES)(
    "%s: a take-over mid-match plays with any notebook and rewrites it within the cap",
    async (strategy) => {
      await inSequence(NOTEBOOKS, async (notebook) => {
        const game = GAMES[name](6);
        game.t = 2 * DAY + 5000;
        const c1 = game.city("c1");
        c1.stock = res(700, 700, 700);
        const colony = capital(
          "c20",
          "p1",
          c1.island,
          game.rules.newCity.buildings,
          res(200, 200, 200),
          {},
        );
        colony.slot = 1;
        colony.capitalOf = null;
        game.cities.push(colony);
        const cap = game.rules.gateway.notesMaxChars;
        const notes = notebook(cap);
        expect(notes.length).toBeLessThanOrEqual(cap);
        game.notes.set("p1", notes);
        const t = game.t;
        const log = await playTurn(strict(strategy), game, "p1", { turn: 9 });
        expect(game.violations).toEqual([]);
        endsWell(game, log, t);
        const writes = callsTo(log, "write_note");
        expect(writes.length).toBe(1);
        expect(writes[0]!["mode"]).toBe("replace");
        const text = str(writes[0]!["text"]);
        expect(text.length).toBeLessThanOrEqual(cap);
        expect(parseMemory(text, strategy).s).toBe(strategy);
        expect(parseMemory(text, strategy).h).not.toBeNull();
      });
    },
  );

  test.each(STRATEGIES)("%s: without hints it still plays", async (strategy) => {
    const game = GAMES[name](6);
    const bot = createBot(strategy, { seat: "p1", seed: 5, hints: null, strict: true });
    await inSequence(upTo(8), async (turn) => {
      const t = game.t;
      const log = await playTurn(bot, game, "p1", { turn });
      expect(game.violations).toEqual([]);
      endsWell(game, log, t);
      advance(game, log.wakeAt ?? t + 3600);
    });
  });
});

describe("caches", () => {
  test("the rules are read once per match while the notebook keeps their key", async () => {
    const game = perfidiaGame(6);
    const bot = strict("expander");
    const first = await playTurn(bot, game, "p1", { turn: 1 });
    expect(callsTo(first, "rules").length).toBe(1);
    advance(game, first.wakeAt ?? 0);
    const second = await playTurn(bot, game, "p1", { turn: 2 });
    expect(callsTo(second, "rules")).toEqual([]);
    // Travel times are cached too: the second turn reads the map without `fromCity`.
    expect(callsTo(second, "view_map")).toEqual([{}]);
  });

  test("two bot instances never share a cache", async () => {
    const game = perfidiaGame(6);
    const a = strict("expander", "p1");
    const logA = await playTurn(a, game, "p1", { turn: 1 });
    expect(callsTo(logA, "rules").length).toBe(1);
    // A second instance for the same seat, handed the first one's notebook (a hand-off): its own
    // cache is empty, so it reads the rules and the travel times again.
    const b = strict("expander", "p1");
    advance(game, logA.wakeAt ?? 0);
    const logB = await playTurn(b, game, "p1", { turn: 2 });
    expect(callsTo(logB, "rules").length).toBe(1);
    expect(callsTo(logB, "view_map")).toEqual([{ fromCity: "c1" }]);
    // And the first instance still has its own.
    advance(game, logB.wakeAt ?? 0);
    const logA2 = await playTurn(a, game, "p1", { turn: 3 });
    expect(callsTo(logA2, "rules")).toEqual([]);
  });

  test("interleaved bots of two matches with different rules keep apart", async () => {
    const p = perfidiaGame(6);
    const s = sandboxGame(6);
    const bp = strict("turtle", "p1");
    const bs = strict("turtle", "p1");
    await inSequence(upTo(6), async (turn) => {
      const lp = await playTurn(bp, p, "p1", { turn });
      const ls = await playTurn(bs, s, "p1", { turn });
      expect(p.violations).toEqual([]);
      expect(s.violations).toEqual([]);
      for (const c of callsTo(lp, "build"))
        for (const b of strs(c["buildings"])) expect(ids(p).has(b)).toBe(true);
      for (const c of callsTo(ls, "build"))
        for (const b of strs(c["buildings"])) expect(ids(s).has(b)).toBe(true);
      advance(p, lp.wakeAt ?? p.t + 3600);
      advance(s, ls.wakeAt ?? s.t + 3600);
    });
  });
});

describe("failures", () => {
  test.each(STRATEGIES)("%s: {ok: false} on every call never throws", async (strategy) => {
    await inSequence(NAMES, async (name) => {
      const game = GAMES[name](6);
      game.t = DAY;
      game.fail = () => "INTERNAL";
      const log = await playTurn(strict(strategy), game, "p1");
      expect(game.violations).toEqual([]);
      expect(log.calls.at(-1)?.tool).toBe("end_turn");
      // Every `end_turn` was rejected: the bot asked again until the round cap, nothing else.
      expect(log.endedBy).toBe("round_cap");
      expect(log.rounds.at(-1)?.map((c) => c.tool)).toEqual(["end_turn"]);
    });
  });

  test("a non-strict bot ends the turn when its own code fails on malformed input", async () => {
    const game = perfidiaGame(6);
    const malformed = z
      .custom<Briefing>(() => true)
      .parse({ ...game.briefing("p1"), cities: null });
    const input: RoundInput = {
      seat: "p1",
      turn: 1,
      round: 0,
      maxRounds: 8,
      maxCalls: 10,
      briefing: malformed,
      results: [],
    };
    const lenient = createBot("expander", { seat: "p1", seed: 1 });
    const out = await lenient.round(input);
    expect(out.calls.map((c) => c.tool)).toEqual(["end_turn"]);
    let threw = false;
    try {
      await strict("expander").round(input);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe("caps", () => {
  test("a single round with a single call is the end_turn", async () => {
    const game = sandboxGame(6);
    const log = await playTurn(strict("rusher"), game, "p1", { maxRounds: 1, maxCalls: 1 });
    expect(log.calls.map((c) => c.tool)).toEqual(["end_turn"]);
    endsWell(game, log, 0);
  });

  test("a per-wake cap of 2 leaves room for end_turn first", async () => {
    const game = perfidiaGame(6);
    const bot = strict("opportunist");
    // Without the rules the bot knows neither the notes cap nor anything to plan with.
    const first = await playTurn(bot, game, "p1", { perWake: 2 });
    expect(first.calls.map((c) => c.tool)).toEqual(["end_turn"]);
    const full = await playTurn(bot, game, "p1", { turn: 2 });
    expect(callsTo(full, "rules").length).toBe(1);
    // A clobbered notebook loses the cache key, so the bot is back to knowing nothing.
    game.notes.set("p1", "overwritten by someone");
    const third = await playTurn(bot, game, "p1", { turn: 3, perWake: 2 });
    expect(third.calls.map((c) => c.tool)).toEqual(["end_turn"]);
  });

  test("attack and message budgets of the briefing are respected", async () => {
    const game = perfidiaGame(6);
    game.t = 5 * DAY;
    game.budget.attacksLeft = 0;
    game.budget.messagesLeft = 0;
    const c1 = game.city("c1");
    c1.levels = {
      hall: 5,
      lumber: 4,
      quarry: 4,
      mine: 4,
      warehouse: 5,
      barracks: 3,
      harbor: 3,
      wall: 1,
    };
    c1.units = { raider: 60, transport: 4 };
    game.intel.set("p1|c2", {
      type: "spy_report",
      at: game.t - 600,
      data: { units: { guard: 1 } },
    });
    game.relations.set("p1", [{ player: "p2", kind: "ally", until: null }]);
    await inSequence(STRATEGIES, async (strategy) => {
      const log = await playTurn(strict(strategy), game, "p1");
      expect(callsTo(log, "attack")).toEqual([]);
      expect(callsTo(log, "send_message")).toEqual([]);
    });
  });
});

/** A random but well-formed situation for one seat. */
const situation = fc.record({
  shape: fc.constantFrom<GameName>("perfidia", "sandbox"),
  strategy: fc.constantFrom(...BOT_STRATEGIES),
  seed: fc.integer({ min: 0, max: 0xffffffff }),
  seat: fc.integer({ min: 1, max: 6 }),
  t: fc.integer({ min: 0, max: 7 * DAY - 1 }),
  turn: fc.integer({ min: 1, max: 60 }),
  maxRounds: fc.integer({ min: 1, max: 8 }),
  maxCalls: fc.integer({ min: 1, max: 12 }),
  perWake: fc.option(fc.integer({ min: 1, max: 40 }), { nil: null }),
  failPm: fc.constantFrom(0, 0, 100, 500, 1000),
  notes: fc.oneof(fc.constant(""), fc.string({ maxLength: 200 }), fc.json({ maxDepth: 3 })),
  developed: fc.boolean(),
  army: fc.integer({ min: 0, max: 120 }),
  founders: fc.integer({ min: 0, max: 3 }),
  carriers: fc.integer({ min: 0, max: 6 }),
  threatened: fc.boolean(),
  friend: fc.boolean(),
  proposal: fc.boolean(),
  intel: fc.integer({ min: 0, max: 200 }),
  stock: fc.integer({ min: 0, max: 5000 }),
});

test("property: any situation gives valid calls within the caps and a proper end", async () => {
  await fc.assert(
    fc.asyncProperty(situation, async (o) => {
      const game = GAMES[o.shape](6);
      const seat: PlayerId = `p${o.seat}`;
      const other: PlayerId = o.seat === 2 ? "p3" : "p2";
      const r = game.rules;
      const own = game.cities.find((c) => c.owner === seat)!;
      game.t = o.t;
      const cap = r.levels.storage[own.levels[r.roles.storage] ?? 0] ?? 0;
      own.stock = res(Math.min(cap, o.stock), Math.min(cap, o.stock), Math.min(cap, o.stock));
      if (o.developed) {
        for (const b of r.buildings) own.levels[b.id] = Math.min(b.maxLevel, 3);
      }
      const units = r.units.map((u) => u.id);
      own.units = {};
      const set = (u: string | undefined, n: number): void => {
        if (u !== undefined && n > 0) own.units[u] = n;
      };
      set(units[0], o.army);
      set(units[1], o.army);
      set(r.roles.settler, o.founders);
      set(r.units.find((u) => u.capacity > 0)?.id, o.carriers);
      const target = game.cities.find((c) => c.owner === other)!;
      if (o.threatened) {
        game.incoming.set(seat, [
          {
            id: "m0k4qz",
            kind: "attack",
            from: target.id,
            by: other,
            foe: seat,
            to: own.id,
            depart: [o.t, "x"],
            arrive: [o.t + 5000, "y"],
          },
        ]);
      }
      if (o.friend) game.relations.set(seat, [{ player: other, kind: "ally", until: null }]);
      if (o.proposal) {
        game.proposals.push({
          id: "q0000a",
          from: other,
          to: seat,
          kind: "pact",
          name: null,
          text: "hi",
          expires: [o.t + 600, "z"],
        });
      }
      game.intel.set(`${seat}|${target.id}`, {
        type: "spy_report",
        at: Math.max(0, o.t - 600),
        data: { units: { [units[0]!]: o.intel } },
      });
      const rng = streamOf(o.seed, "fail");
      game.fail = (_s: PlayerId, c: ToolCall) =>
        c.tool !== "end_turn" && randInt(rng, 0, 999) < o.failPm ? "INSUFFICIENT_RESOURCES" : null;

      const bot = strict(o.strategy, seat, o.seed);
      const log = await playTurn(bot, game, seat, {
        turn: o.turn,
        maxRounds: o.maxRounds,
        maxCalls: o.maxCalls,
        perWake: o.perWake,
        notes: o.notes,
      });
      expect(game.violations).toEqual([]);
      expect(log.rounds.length).toBeLessThanOrEqual(o.maxRounds);
      if (o.perWake !== null) expect(log.calls.length).toBeLessThanOrEqual(o.perWake);
      if (log.endedBy === "empty_round") {
        expect(o.perWake !== null && log.calls.length >= o.perWake).toBe(true);
      } else {
        endsWell(game, log, o.t);
      }
      for (const w of callsTo(log, "write_note")) {
        expect(str(w["text"]).length).toBeLessThanOrEqual(r.gateway.notesMaxChars);
      }
    }),
    { numRuns: 250 },
  );
}, 60_000);
