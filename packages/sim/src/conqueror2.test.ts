// conqueror@2 (docs/architecture.md §11.2) on a real seeded perfidia-1 match, through the gateway:
// it founds cities past conqueror@1's cap of four, takes a city by a siege of its own, proposes a war
// alliance, and the match is a pure function of its seed (the same log twice). Four game days keep
// the test fast; this seed has its first conquest on day 4.

import { describe, expect, test } from "bun:test";
import type { EvLine, LogLine } from "@perfidia/protocol";
import { normalisedHash, runBots, type BotRunSpec } from "./harness/index.ts";
import { summarize } from "./summary/index.ts";

/** Six seats, every version pinned: the default bots with conqueror@2 at p5 (p6 an expander). */
const SPEC: BotRunSpec = {
  ruleset: "perfidia-1@1.0.0",
  seed: 12,
  players: 6,
  days: 4,
  bots: ["expander@1", "rusher@2", "turtle@1", "opportunist@1", "conqueror@2", "expander@1"],
  clock: { kind: "lockstep" },
  strict: true,
};

const events = (lines: readonly LogLine[], type: string): EvLine[] =>
  lines.filter((l): l is EvLine => l.k === "ev" && l.e.type === type);

const str = (v: unknown): string => (typeof v === "string" ? v : "");

describe("conqueror@2 on a real match (perfidia-1, seed 12, 6 seats, 4 days)", () => {
  test("it keeps founding past four cities and conquers by its own siege; the same seed gives the same log", async () => {
    const a = await runBots(SPEC);
    expect(a.lines.at(-1)?.k).toBe("end");
    const header = a.lines.find((l) => l.k === "header");
    expect(header?.k === "header" ? header.controllers["p5"] : null).toBe("bot:conqueror@2");
    const s = summarize(a.lines);
    expect(s.internal).toBe(0);

    const founded = events(a.lines, "city_founded").filter((l) => l.e.data["owner"] === "p5");
    expect(founded.length).toBeGreaterThanOrEqual(4);

    const sieges = new Set(
      events(a.lines, "siege_started")
        .filter((l) => l.e.data["by"] === "p5")
        .map((l) => str(l.e.data["city"])),
    );
    const taken = events(a.lines, "city_conquered").filter((l) => l.e.data["to"] === "p5");
    expect(taken.length).toBeGreaterThan(0);
    for (const l of taken) expect(sieges.has(str(l.e.data["city"]))).toBe(true);
    // More cities than conqueror@1 ever holds (its cap of four, conquests included).
    expect(s.seats.find((x) => x.seat === "p5")?.cities ?? 0).toBeGreaterThan(4);

    const proposals = a.lines.filter(
      (l) => l.k === "act" && l.seat === "p5" && l.tool === "propose_alliance" && l.r.ok,
    );
    expect(proposals.length).toBeGreaterThan(0);

    const b = await runBots(SPEC);
    expect(normalisedHash(b.lines)).toBe(normalisedHash(a.lines));
  }, 60_000);
});
