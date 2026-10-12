// rusher@2 on a real seeded match (docs/architecture.md §11.2, perfidia-1 §15.1): the four bots
// play a 1-game-day perfidia-1 match through the gateway, with rusher@2 on p2 and p6. The rushers
// spy before protection ends, launch their first wave as it ends, and the first battle lands on day
// 1 at 13:00–16:00 (a neighbour is three hours away); the same seed gives the same log.

import { describe, expect, test } from "bun:test";
import { createBotVersion } from "@perfidia/bots";
import { MemorySink } from "@perfidia/gateway";
import type { LogLine, PlayerId, SeatAgent } from "@perfidia/protocol";
import { normalisedText, prepareBotRun, runPrepared } from "./harness/index.ts";

const FROM = 43200;
const RUSHERS: readonly PlayerId[] = ["p2", "p6"];
const isRusher = (p: unknown): boolean => RUSHERS.some((seat) => seat === p);

/** Day 1 of a 6-seat perfidia-1 match of the four bots, rusher@2 on the rusher seats. */
async function dayOne(seed: number): Promise<LogLine[]> {
  const prepared = prepareBotRun({
    ruleset: "perfidia-1",
    seed,
    players: 6,
    days: 1,
    clock: { kind: "lockstep" },
    bots: ["expander", "rusher", "turtle", "opportunist"],
    strict: true,
  });
  const agents = new Map<PlayerId, SeatAgent>(prepared.options.agents);
  for (const seat of RUSHERS) {
    agents.set(seat, createBotVersion("rusher", 2, { seat, seed, strict: true }));
  }
  const sink = new MemorySink();
  await runPrepared({ ...prepared, options: { ...prepared.options, agents } }, sink);
  return sink.parsed();
}

describe("rusher@2 on a real 6-seat perfidia-1 match (seed 1, day 1)", () => {
  test("it spies before protection ends, launches as it ends, and the first battle lands at 13:00–16:00", async () => {
    const lines = await dayOne(1);
    const header = lines[0];
    expect(header?.k).toBe("header");
    if (header?.k !== "header") return;
    for (const seat of RUSHERS) expect(header.controllers[seat]).toBe("bot:rusher@2");
    expect(lines.some((l) => l.k === "fatal")).toBe(false);

    const acts = lines.flatMap((l) => (l.k === "act" && l.r.ok ? [l] : []));
    const firstLaunch: number[] = [];
    for (const seat of RUSHERS) {
      const mine = acts.filter((a) => a.seat === seat);
      const attacks = mine.filter((a) => a.tool === "attack");
      expect(attacks.filter((a) => a.t < FROM)).toEqual([]);
      expect(mine.some((a) => a.tool === "spy" && a.t < FROM)).toBe(true);
      const first = attacks[0];
      expect(first).toBeDefined();
      if (first === undefined || first.a.type !== "attack") continue;
      firstLaunch.push(first.t);
      // About twenty attackers in the first wave (perfidia-1 §15.1), lifted by their carriers.
      expect(first.a.units["raider"] ?? 0).toBeGreaterThanOrEqual(15);
      expect(first.a.units["transport"] ?? 0).toBeGreaterThan(0);
    }
    expect(Math.min(...firstLaunch)).toBeLessThanOrEqual(FROM + 900);

    const battles = lines.flatMap((l) =>
      l.k === "ev" && l.e.type === "battle" && isRusher(l.e.data["attacker"]) ? [l.t] : [],
    );
    expect(battles.length).toBeGreaterThan(0);
    expect(battles[0]!).toBeGreaterThanOrEqual(FROM + 3600);
    expect(battles[0]!).toBeLessThanOrEqual(FROM + 4 * 3600);
  }, 60_000);

  test("the same seed gives the same log", async () => {
    const a = await dayOne(1);
    const b = await dayOne(1);
    expect(normalisedText(b)).toBe(normalisedText(a));
  }, 60_000);
});
