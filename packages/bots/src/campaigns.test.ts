// Multi-day campaigns from the start position (docs/architecture.md §11.2): one bot plays against
// the fake game (other seats idle, spies always succeed), turn after turn at its own self-wakes.
// They check the behaviour a single fixture turn cannot: that the rusher (@1, frozen) gets its
// carriers and raids across water whatever its city cap, and that the opportunist betrays a pact
// partner it can only see through spy reports. rusher@2's campaigns are in rusher2.test.ts.
// The opportunist's campaigns run in the slow suite (PERFIDIA_SLOW=1, docs/architecture.md §13.8:
// `bun run test:slow`, run by `bun run test:exit`).

import { describe, expect, test } from "bun:test";
import { CityIdSchema } from "@perfidia/protocol";
import {
  advance,
  callsTo,
  counts,
  perfidiaGame,
  playTurn,
  sandboxGame,
  strs,
  type FakeGame,
} from "./fixtures.test.ts";
import { createBot, createBotVersion } from "./registry.ts";
import { streamOf } from "./rng.ts";
import { opportunist, opportunistParams } from "./strategies/opportunist.ts";
import { rusher } from "./strategies/rusher.ts";
import type { BotStrategy } from "./strategies/strategy.ts";

const SLOW = process.env["PERFIDIA_SLOW"] === "1";
/** A test of the slow suite: skipped unless PERFIDIA_SLOW=1. */
const xtest = test.skipIf(!SLOW);

const DAY = 86400;
const SHAPES: { name: string; game: (players?: number) => FakeGame }[] = [
  { name: "perfidia-1 shape", game: perfidiaGame },
  { name: "sandbox-1 shape", game: sandboxGame },
];

interface Act {
  readonly t: number;
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

/**
 * Plays `strategy` (its latest version, or `version`) for p1 from the game's current time until
 * `until`; every call it made, timed.
 */
async function campaign(
  game: FakeGame,
  strategy: BotStrategy,
  seed: number,
  until: number,
  version?: number,
): Promise<Act[]> {
  const o = { seat: "p1", seed, strict: true } as const;
  const bot =
    version === undefined ? createBot(strategy, o) : createBotVersion(strategy, version, o);
  const acts: Act[] = [];
  let turn = 0;
  while (game.t < until) {
    turn += 1;
    const t = game.t;
    // oxlint-disable-next-line no-await-in-loop -- each turn starts from the state the last one left
    const log = await playTurn(bot, game, "p1", { turn });
    expect(game.violations).toEqual([]);
    expect(log.endedBy).toBe("end_turn");
    for (const tool of ["build", "recruit", "spy", "attack", "send_message"] as const) {
      for (const args of callsTo(log, tool)) acts.push({ t, tool, args });
    }
    advance(game, log.wakeAt ?? t + 3600);
  }
  return acts;
}

describe.each(SHAPES)("$name", (shape) => {
  test("rusher@1 unlocks carriers early and raids across water, whatever its city cap", async () => {
    // Seeds 1 to 3 cap the rusher at 2 cities (its second on its own island), seed 4 at 3.
    const caps = [1, 2, 3, 4].map(
      (seed) => rusher.brain(streamOf(seed, "p1", "rusher", "params")).knobs.maxCities,
    );
    expect(caps).toEqual([2, 2, 2, 3]);
    for (const seed of [1, 2, 3, 4]) {
      const game = shape.game(6);
      const home = game.city("c1").island;
      const carrier = game.rules.units.find((u) => u.capacity > 0)!;
      // oxlint-disable-next-line no-await-in-loop -- one campaign at a time
      const acts = await campaign(game, "rusher", seed, 3 * DAY, 1);
      const carrierBuild = acts.find(
        (a) => a.tool === "build" && strs(a.args["buildings"]).includes(carrier.queue),
      );
      const carrierRecruit = acts.find(
        (a) => a.tool === "recruit" && JSON.stringify(a.args["orders"]).includes(`"${carrier.id}"`),
      );
      expect(carrierBuild?.t ?? Infinity).toBeLessThan(DAY);
      expect(carrierRecruit?.t ?? Infinity).toBeLessThan(2 * DAY);
      const attacks = acts.filter((a) => a.tool === "attack");
      expect(attacks.length).toBeGreaterThan(0);
      for (const a of attacks) {
        expect(a.t).toBeGreaterThanOrEqual(game.rules.time.attackFrom);
        const target = game.city(CityIdSchema.parse(a.args["to"]));
        expect(target.owner).not.toBeNull();
        expect(target.owner).not.toBe("p1");
        // Every other player is across water: the attack carries its carriers.
        expect(target.island).not.toBe(home);
        expect(counts(a.args["units"])[carrier.id] ?? 0).toBeGreaterThan(0);
      }
      // Each first attack on a city follows a spy report on it.
      for (const a of attacks) {
        const to = a.args["to"];
        expect(acts.some((s) => s.tool === "spy" && s.args["to"] === to && s.t < a.t)).toBe(true);
      }
    }
  }, 60_000);

  xtest("the opportunist spies, then betrays a pact partner on or after its seeded day", async () => {
    for (const seed of [1, 2]) {
      const prm = opportunistParams(streamOf(seed, "p1", "opportunist", "params"));
      expect(opportunist.brain(streamOf(seed, "p1", "opportunist", "params")).knobs.carriers).toBe(
        true,
      );
      const game = shape.game(6);
      game.relations.set("p1", [{ player: "p2", kind: "pact", until: null }]);
      game.relations.set("p2", [{ player: "p1", kind: "pact", until: null }]);
      // oxlint-disable-next-line no-await-in-loop -- one campaign at a time
      const acts = await campaign(game, "opportunist", seed, 6 * DAY, 1);
      const attacks = acts.filter((a) => a.tool === "attack");
      expect(attacks.map((a) => a.args["to"])).toEqual(["c2"]);
      const strike = attacks[0]!;
      expect(Math.floor(strike.t / DAY)).toBeGreaterThanOrEqual(prm.betrayDay);
      const spied = acts.filter((a) => a.tool === "spy" && a.args["to"] === "c2");
      expect(spied.length).toBeGreaterThan(0);
      expect(spied[0]!.t).toBeLessThan(strike.t);
      expect(Math.floor(spied[0]!.t / DAY)).toBeGreaterThanOrEqual(prm.betrayDay - 1);
      expect(
        acts.some(
          (a) =>
            a.tool === "send_message" && a.t === strike.t && a.args["text"] === "we remain friends",
        ),
      ).toBe(true);
    }
  }, 60_000);
});
