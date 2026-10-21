// The relief pack (docs/architecture.md §11.2) on real seeded perfidia-1 matches, through the
// gateway: expander@2 breaks the siege of its own city, opportunist@2 the siege of its ally's
// city, both by a relief battle (perfidia-1 §9.3); expander@2 attacks no one else; the same seed
// gives the same log. Each match is cut at the end of day 2 to keep the test fast.
// Slow suite only (docs/architecture.md §13.8): skipped unless PERFIDIA_SLOW=1
// (`bun run test:slow`, which `bun run test:exit` runs).

import { describe, expect, test } from "bun:test";
import type { ActLine, EvLine, LogLine } from "@perfidia/protocol";
import { normalisedHash, runBots, type BotRunSpec } from "./harness/index.ts";
import { summarize } from "./summary/index.ts";

const SLOW = process.env["PERFIDIA_SLOW"] === "1";
/** A group of tests of the slow suite: skipped unless PERFIDIA_SLOW=1. */
const xdescribe = describe.skipIf(!SLOW);

/** Six seats, every version pinned, so that a later version of any bot does not change these matches. */
const spec = (seed: number): BotRunSpec => ({
  ruleset: "perfidia-1@1.0.0",
  seed,
  players: 6,
  days: 2,
  bots: ["expander@2", "rusher@2", "turtle@2", "opportunist@2", "conqueror@1", "expander@2"],
  clock: { kind: "lockstep" },
  strict: true,
});

const events = (lines: readonly LogLine[], type: string): EvLine[] =>
  lines.filter((l): l is EvLine => l.k === "ev" && l.e.type === type);

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The relief battles that broke a siege: `[attacker, city, the city's owner]`. */
function brokenByRelief(lines: readonly LogLine[]): [string, string, string][] {
  const broken = events(lines, "siege_broken").filter((l) => l.e.data["cause"] === "relief");
  return events(lines, "battle")
    .filter((l) => l.e.data["kind"] === "relief" && l.e.data["winner"] === "attacker")
    .filter((l) => broken.some((b) => b.t === l.t && b.e.data["city"] === l.e.data["city"]))
    .map((l) => {
      const city = str(l.e.data["city"]);
      const b = broken.find((x) => x.t === l.t && x.e.data["city"] === city);
      return [str(l.e.data["attacker"]), city, str(b?.e.data["owner"])];
    });
}

/**
 * Every attack an expander@2 seat launched fought the besieger of a city under siege (a relief):
 * the peaceful reference player starts no war (no countdown runs before day 4).
 */
function expanderAttacksAreReliefs(lines: readonly LogLine[]): void {
  const header = lines.find((l) => l.k === "header");
  if (header?.k !== "header") throw new Error("no header");
  const expanders = Object.entries(header.controllers)
    .filter(([, label]) => label === "bot:expander@2")
    .map(([seat]) => seat);
  expect(expanders.length).toBe(2);
  const open = new Map<string, string>();
  for (const l of lines) {
    if (l.k === "ev" && l.e.type === "siege_started") {
      open.set(str(l.e.data["city"]), str(l.e.data["by"]));
    }
    if (l.k === "ev" && (l.e.type === "siege_broken" || l.e.type === "city_conquered")) {
      open.delete(str(l.e.data["city"]));
    }
    if (l.k !== "act" || l.tool !== "attack" || !l.r.ok) continue;
    const act: ActLine = l;
    if (!expanders.includes(act.seat) || act.a.type !== "attack") continue;
    const besieger = open.get(act.a.to);
    expect([act.seat, act.a.to, besieger !== undefined && besieger !== act.seat]).toEqual([
      act.seat,
      act.a.to,
      true,
    ]);
  }
}

xdescribe("relief on real matches (perfidia-1, 6 seats, days 1–2)", () => {
  test("seed 35: expander@2 breaks the siege of its own city, and the same seed gives the same log", async () => {
    const a = await runBots(spec(35));
    expect(a.lines.at(-1)?.k).toBe("end");
    expect(summarize(a.lines).internal).toBe(0);
    const reliefs = brokenByRelief(a.lines);
    // p1 (expander@2) relieved its own city.
    expect(reliefs.some(([by, , owner]) => by === "p1" && owner === "p1")).toBe(true);
    expanderAttacksAreReliefs(a.lines);
    const b = await runBots(spec(35));
    expect(normalisedHash(b.lines)).toBe(normalisedHash(a.lines));
  }, 60_000);

  test("seed 29: opportunist@2 breaks the siege of its ally's city", async () => {
    const lines = (await runBots(spec(29))).lines;
    expect(lines.at(-1)?.k).toBe("end");
    const reliefs = brokenByRelief(lines);
    // p4 (opportunist@2) relieved a city of p5 (conqueror@1), its ally then.
    expect(reliefs.some(([by, , owner]) => by === "p4" && owner === "p5")).toBe(true);
    const formed = events(lines, "alliance_formed").map((l) => l.e.data["members"]);
    expect(formed).toContainEqual(["p4", "p5"]);
    expanderAttacksAreReliefs(lines);
  }, 60_000);
});
