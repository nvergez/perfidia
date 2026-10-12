// The conqueror bot (docs/architecture.md §11.2) on real seeded perfidia-1 matches, through the
// gateway: it eliminates its victim (§9.7 of the ruleset), its last city taken by the conqueror's
// own siege, and the match is a pure function of its seed (the same log twice). The match is cut
// at the end of day 5 to keep the test fast; this seed eliminates on day 4.

import { describe, expect, test } from "bun:test";
import type { EvLine, LogLine, NoteLine } from "@perfidia/protocol";
import { normalisedHash, runBots, type BotRunSpec } from "./harness/index.ts";
import { summarize } from "./summary/index.ts";

const DAY = 86400;

/** Six seats: the default bots with the conqueror at p5 (p6 is the second rusher). */
const SPEC: BotRunSpec = {
  ruleset: "perfidia-1@1.0.0",
  seed: 13,
  players: 6,
  days: 5,
  bots: ["expander", "rusher", "turtle", "opportunist", "conqueror", "rusher"],
  clock: { kind: "lockstep" },
  strict: true,
};

const events = (lines: readonly LogLine[], type: string): EvLine[] =>
  lines.filter((l): l is EvLine => l.k === "ev" && l.e.type === type);

const str = (v: unknown): string => (typeof v === "string" ? v : "");

describe("conqueror on a real match (perfidia-1, seed 13, 6 seats)", () => {
  test("it eliminates its victim by conquest, and the same seed gives the same log", async () => {
    const a = await runBots(SPEC);
    expect(a.lines.at(-1)?.k).toBe("end");
    const header = a.lines.find((l) => l.k === "header");
    expect(header?.k === "header" ? header.controllers["p5"] : null).toBe("bot:conqueror@1");

    const eliminated = events(a.lines, "player_eliminated");
    expect(eliminated.length).toBeGreaterThan(0);
    const first = eliminated[0]!;
    const victim = str(first.e.data["player"]);
    // The victim's last city fell to the conqueror in the same second: a siege the conqueror held.
    const lastCity = events(a.lines, "city_conquered").filter((l) => l.t === first.t);
    expect(lastCity.map((l) => [str(l.e.data["from"]), str(l.e.data["to"])])).toContainEqual([
      victim,
      "p5",
    ]);
    expect(first.t).toBeLessThan(5 * DAY);
    // It was the victim the conqueror kept in its notes.
    const notes = a.lines.filter(
      (l): l is NoteLine => l.k === "note" && l.seat === "p5" && l.t <= first.t,
    );
    const memory: unknown = JSON.parse(notes.at(-1)?.text ?? "{}");
    expect(memory).toMatchObject({ s: "conqueror", x: { vp: Number(victim.slice(1)), vc: 1 } });

    // Every city the conqueror took came from a siege it started and held.
    const s = summarize(a.lines);
    expect(s.events.eliminations).toBeGreaterThan(0);
    const taken = events(a.lines, "city_conquered").filter((l) => l.e.data["to"] === "p5");
    const started = events(a.lines, "siege_started").filter((l) => l.e.data["by"] === "p5");
    expect(taken.length).toBeGreaterThanOrEqual(2);
    expect(started.length).toBeGreaterThanOrEqual(taken.length);
    expect(s.internal).toBe(0);

    const b = await runBots(SPEC);
    expect(normalisedHash(b.lines)).toBe(normalisedHash(a.lines));
  }, 120_000);
});
