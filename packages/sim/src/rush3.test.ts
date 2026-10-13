// rusher@3 on a real seeded match (docs/architecture.md §11.2, perfidia-1 §15.1): the default-like
// six seats with rusher@3 at p2, every version pinned, cut at the end of day 2 to stay fast. The
// rusher keeps rusher@2's rush (spies landed by protection end, a wave launched as it ends, the
// first battle on day 1) and grows: a second city founded before the end of day 2, its founder
// sent once its first wave has left. The same seed gives the same log.

import { describe, expect, test } from "bun:test";
import type { EvLine, LogLine } from "@perfidia/protocol";
import { normalisedText, runBots, type BotRunSpec } from "./harness/index.ts";

const DAY = 86400;
const FROM = 43200;
const RUSHER = "p2";

const SPEC: BotRunSpec = {
  ruleset: "perfidia-1@1.0.0",
  seed: 3,
  players: 6,
  days: 2,
  bots: ["expander@1", "rusher@3", "turtle@1", "opportunist@1", "conqueror@1", "expander@1"],
  clock: { kind: "lockstep" },
  strict: true,
};

const events = (lines: readonly LogLine[], type: string): EvLine[] =>
  lines.filter((l): l is EvLine => l.k === "ev" && l.e.type === type);

describe("rusher@3 on a real 6-seat perfidia-1 match (seed 3, two days)", () => {
  test("it rushes on day 1, founds a city by day 2, and the same seed gives the same log", async () => {
    const a = await runBots(SPEC);
    expect(a.lines.at(-1)?.k).toBe("end");
    const header = a.lines[0];
    expect(header?.k === "header" ? header.controllers[RUSHER] : null).toBe("bot:rusher@3");
    expect(a.lines.some((l) => l.k === "fatal")).toBe(false);

    const acts = a.lines.flatMap((l) => (l.k === "act" && l.r.ok && l.seat === RUSHER ? [l] : []));
    // The rush: spies before protection ends, no launch before it, a wave of about twenty attackers
    // with its carriers as it ends.
    expect(acts.some((x) => x.tool === "spy" && x.t < FROM)).toBe(true);
    const attacks = acts.filter((x) => x.tool === "attack");
    expect(attacks.filter((x) => x.t < FROM)).toEqual([]);
    const first = attacks[0];
    expect(first?.t).toBeLessThanOrEqual(FROM + 900);
    if (first?.a.type === "attack") {
      expect(first.a.units["raider"] ?? 0).toBeGreaterThanOrEqual(15);
      expect(first.a.units["transport"] ?? 0).toBeGreaterThan(0);
    }
    const battle = events(a.lines, "battle").find((l) => l.e.data["attacker"] === RUSHER);
    expect(battle?.t).toBeGreaterThanOrEqual(FROM + 3600);
    expect(battle?.t).toBeLessThan(DAY);

    // It grows: its founder leaves after the first wave and a city is founded before day 3.
    const founds = acts.filter((x) => x.tool === "found_city");
    expect(founds.length).toBeGreaterThan(0);
    expect(founds[0]!.t).toBeGreaterThan(first?.t ?? 0);
    const founded = events(a.lines, "city_founded").filter((l) => l.e.data["owner"] === RUSHER);
    expect(founded.length).toBeGreaterThan(0);
    expect(founded[0]!.t).toBeLessThan(2 * DAY);

    const b = await runBots(SPEC);
    expect(normalisedText(b.lines)).toBe(normalisedText(a.lines));
  }, 30_000);
});
