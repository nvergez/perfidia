// conqueror@3 (docs/architecture.md §11.2, pinned by `name@3`) on a real seeded perfidia-1
// match, through the gateway: its garrison leaves as supports with the founders' wave and lands in
// the same second, the city falls to its own siege, it asks its ally to hold the city (a `siege` war
// call, `war.ts`), and the match is a pure function of its seed (the same log twice). Four game days
// keep the test fast.

import { describe, expect, test } from "bun:test";
import type { ActLine, EvLine, LogLine } from "@perfidia/protocol";
import { normalisedHash, runBots, type BotRunSpec } from "./harness/index.ts";
import { summarize } from "./summary/index.ts";

/** Six seats, every version pinned: the @2 bots with conqueror@3 at p5. */
const SPEC: BotRunSpec = {
  ruleset: "perfidia-1@1.0.0",
  seed: 8,
  players: 6,
  days: 4,
  bots: ["expander@2", "rusher@3", "turtle@2", "opportunist@2", "conqueror@3", "expander@2"],
  clock: { kind: "lockstep" },
  strict: true,
};

const events = (lines: readonly LogLine[], type: string): EvLine[] =>
  lines.filter((l): l is EvLine => l.k === "ev" && l.e.type === type);

const acts = (lines: readonly LogLine[], seat: string, type: string): ActLine[] =>
  lines.filter(
    (l): l is ActLine => l.k === "act" && l.seat === seat && l.r.ok && l.a.type === type,
  );

const str = (v: unknown): string => (typeof v === "string" ? v : "");

describe("conqueror@3 on a real match (perfidia-1, seed 8, 6 seats, 4 days)", () => {
  test("its garrison lands with its founders, the city falls to its siege, its ally is asked to hold it; the same seed gives the same log", async () => {
    const a = await runBots(SPEC);
    expect(a.lines.at(-1)?.k).toBe("end");
    const header = a.lines.find((l) => l.k === "header");
    expect(header?.k === "header" ? header.controllers["p5"] : null).toBe("bot:conqueror@3");
    expect(summarize(a.lines).internal).toBe(0);

    const sieges = new Set(
      events(a.lines, "siege_started")
        .filter((l) => l.e.data["by"] === "p5")
        .map((l) => str(l.e.data["city"])),
    );
    const taken = events(a.lines, "city_conquered").filter((l) => l.e.data["to"] === "p5");
    expect(taken.length).toBeGreaterThan(0);
    for (const l of taken) expect(sieges.has(str(l.e.data["city"]))).toBe(true);

    // The garrison of a conquest: a support from p5 that left with the founders' wave and landed
    // in the same second.
    const city = str(taken[0]!.e.data["city"]);
    const arrivals = (kind: "incoming_attack" | "incoming_support"): number[] =>
      events(a.lines, kind)
        .filter((l) => l.e.data["by"] === "p5" && l.e.data["to"] === city)
        .map((l) => Number(l.e.data["arriveAt"]));
    const founders = acts(a.lines, "p5", "attack").filter(
      (l) => l.a.type === "attack" && l.a.to === city && (l.a.units["settler"] ?? 0) > 0,
    );
    expect(founders.length).toBeGreaterThan(0);
    const supports = acts(a.lines, "p5", "support").filter(
      (l) => l.a.type === "support" && l.a.to === city,
    );
    expect(supports.some((s) => founders.some((f) => f.t === s.t))).toBe(true);
    const supported = new Set(arrivals("incoming_support"));
    expect(arrivals("incoming_attack").some((t) => supported.has(t))).toBe(true);

    // A `siege` call to its allies, in the tagged format any bot or model can read.
    const calls = acts(a.lines, "p5", "send_message")
      .map((l) => (l.a.type === "send_message" ? l.a.text : ""))
      .filter((t) => /^WAR#k[0-9a-z]+ siege c[0-9]+ /.test(t));
    expect(calls.length).toBeGreaterThan(0);

    const b = await runBots(SPEC);
    expect(normalisedHash(b.lines)).toBe(normalisedHash(a.lines));
  }, 60_000);
});
