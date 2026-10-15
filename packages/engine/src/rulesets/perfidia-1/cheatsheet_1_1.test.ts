import { describe, expect, test } from "bun:test";
import { MatchConfigError, resolveConfig } from "@perfidia/engine/kernel";
import type { Json } from "@perfidia/protocol";
import { renderCheatSheet11 } from "./cheatsheet_1_1.ts";
import { perfidia1_1_1_0 } from "./v1_1_0.ts";

// The cheat sheet of perfidia-1@1.1.0 (docs/rulesets/perfidia-1.md §0): verbatim with the defaults
// at N = 6, the WIN numbers for every N, and the variants of the WIN and SCORE lines.

const P11 = perfidia1_1_1_0;

/** §0 of docs/rulesets/perfidia-1.md, verbatim (perfidia-1@1.1.0, N = 6). */
const SECTION_0 = `TIME        integer game-seconds. 1 day = 86400. Match = 7 days = 604800.
            No attack launches before 12:00 (43200). Capitals cannot be besieged before day 3 (172800).
TRAVEL      same island: 1 h. Other island: tiles × 60 s (with transports), × 45 s (triremes only),
            × 30 s (spy, no units). Never less than 1 h. Same time both ways. view_map lists them.
            An incoming attack shows its origin, owner, launch and arrival times, never its units.
            Its pace therefore shows whether it is triremes only.
            A return heading into a city you besiege shows its owner and times only, never its origin.
PRODUCTION  producer level L: 50 + 20L + 5L² per hour. Frontier ×1.5, inner/hub ×1.25, Olympus ×1.5.
STORAGE     warehouse L holds 60L² + 280L + 660 of each resource. 100·L of each is safe from loot.
POPULATION  acropolis L allows 2L² + 20L + 40 pop. Every unit homed in the city counts, wherever it is.
BUILD       level L costs base × (L² + 3L + 6) / 10. It takes baseTime × (L² + 3L + 6) / (9 + acropolis) s.
RECRUIT     unit time = baseTime × 10 / (9 + barracks or harbor level). Units arrive one by one.
UNITS       hoplite defends (atk 5, def 20, carries 10). peltast attacks (atk 20, def 5, carries 50).
            settler founds a city or holds a siege. transport carries 20 pop across water.
            trireme fights only at sea (naval 50). Only hoplites and peltasts fight on land.
SETTLER     450 wood / 450 stone / 750 gold × k, where k = your cities + your settlers (k ≤ 10).
COMBAT      naval phase (only across water): triremes 50 each. Losing it sinks the whole attack.
            land phase: A = Σ attack  vs  D = (Σ defense + 50 + 20·acropolis) × (1 + 5%·wall).
            The defender wins ties. Morale: −10% attack per city you own above the foe (floor 70%).
LOSSES      The loser loses everything in that phase. The winner loses (loser/winner)² of each stack.
            Example: winning at 2:1 costs 25%; at 3:2 it costs 44%. Below 1.41:1 a lone settler dies.
AFTER A WIN all defenders die and the wall drops 1. With no settler alive: loot (peltast carries 50).
            With a settler alive: a public 6 h SIEGE. The city is yours at the end unless someone
            kills every settler in your garrison first.
SCORE       100 per city + 1 per building level + 100 for Olympus
            + 1 per 10 enemy pop killed (capped at 1/4 of your city points).
WIN         From day 4: a bloc (alliance or lone player) holding ≥ 16 cities (35% of the 43 city slots),
            ≥ 2 of them taken, for 24 h in public. The countdown must start by D7 00:00 to end in time.
            A city counts as taken when its owner conquered it and no member of the owner's bloc ever
            held it. Otherwise the highest score at the end of day 7.`;

function sheet(overrides: Readonly<Record<string, Json>> = {}, n = 6): string {
  const r = resolveConfig(P11, overrides);
  if (!r.ok) throw new MatchConfigError(r.errors);
  return renderCheatSheet11(r.config, P11.compile(r.config, n));
}

const units = (text: string): string[] => {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith("UNITS"));
  return lines.slice(at, at + 3);
};
const win = (text: string): string[] =>
  text.split("\n").slice(text.split("\n").findIndex((l) => l.startsWith("WIN")));
const score = (text: string): string[] => {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith("SCORE"));
  const end = lines.findIndex((l) => l.startsWith("WIN"));
  return lines.slice(at, end);
};

describe("the cheat sheet of 1.1.0", () => {
  test("is §0 verbatim with the defaults at N = 6", () => {
    expect(sheet()).toBe(SECTION_0);
    expect(P11.cheatSheet(P11.defaults, P11.compile(P11.defaults, 6))).toBe(SECTION_0);
  });

  test("keeps 12-column labels and lines of at most 107 characters", () => {
    for (let n = 6; n <= 12; n += 1) {
      for (const line of sheet({}, n).split("\n")) {
        expect(line.length).toBeLessThanOrEqual(107);
        expect(line.slice(0, 12)).toMatch(/^([A-Z][A-Z ]*[A-Z] *|\s{12})$/);
      }
    }
  });

  test("gives the threshold and the map's slots for each N", () => {
    const firsts = [];
    for (let n = 6; n <= 12; n += 1) {
      const m = /holding ≥ (\d+) cities \(35% of the (\d+) city slots\),/.exec(sheet({}, n));
      firsts.push([n, Number(m?.[1]), Number(m?.[2])]);
    }
    expect(firsts).toEqual([
      [6, 16, 43],
      [7, 18, 50],
      [8, 18, 49],
      [9, 20, 55],
      [10, 22, 61],
      [11, 24, 67],
      [12, 26, 73],
    ]);
  });

  test("names the floor per player only when it is the larger term, and the taken cities", () => {
    expect(
      win(sheet({ "victory.dominationMinPerPlayer": 1, "victory.dominationPm": 400 })),
    ).toEqual([
      "WIN         From day 4: a bloc (alliance or lone player) holding ≥ 18 cities (40% of the 43 city slots),",
      "            ≥ 2 of them taken, for 24 h in public. The countdown must start by D7 00:00 to end in time.",
      "            A city counts as taken when its owner conquered it and no member of the owner's bloc ever",
      "            held it. Otherwise the highest score at the end of day 7.",
    ]);
    expect(win(sheet({ "victory.dominationMinPerPlayer": 3 }))).toEqual([
      "WIN         From day 4: a bloc (alliance or lone player) holding ≥ 18 cities (3 per player; 35% of the",
      "            43 city slots is only 16), ≥ 2 of them taken, for 24 h in public. The countdown must start",
      "            by D7 00:00 to end in time. A city counts as taken when its owner conquered it and no member",
      "            of the owner's bloc ever held it. Otherwise the highest score at the end of day 7.",
    ]);
    expect(win(sheet({ "victory.dominationMinConquests": 1 }))[1]).toContain("≥ 1 of them taken");
  });

  test("drops the taken clause and its definition with dominationMinConquests 0", () => {
    expect(win(sheet({ "victory.dominationMinConquests": 0 }))).toEqual([
      "WIN         From day 4: a bloc (alliance or lone player) holding ≥ 16 cities (35% of the 43 city slots),",
      "            for 24 h in public. The countdown must start by D7 00:00 to end in time. Otherwise the",
      "            highest score at the end of day 7.",
    ]);
  });

  test("gives the last second a countdown can start: matchEnd − dominationHold", () => {
    expect(win(sheet({ "time.dominationHold": 43200 }))[1]).toContain(
      "for 12 h in public. The countdown must start by D7 12:00 to end in time.",
    );
    expect(win(sheet({ "time.matchEnd": 345600 }))[1]).toContain("must start by D4 00:00");
  });

  test("UNITS gives each unit's role from its numbers", () => {
    expect(units(sheet())).toEqual([
      "UNITS       hoplite defends (atk 5, def 20, carries 10). peltast attacks (atk 20, def 5, carries 50).",
      "            settler founds a city or holds a siege. transport carries 20 pop across water.",
      "            trireme fights only at sea (naval 50). Only hoplites and peltasts fight on land.",
    ]);
    const swapped = units(
      sheet({
        "units.hoplite.attack": 20,
        "units.hoplite.defense": 5,
        "units.peltast.attack": 7,
        "units.peltast.defense": 7,
      }),
    );
    expect(swapped[0]).toBe(
      "UNITS       hoplite attacks (atk 20, def 5, carries 10). peltast attacks and defends (atk 7, def 7, carries 50).",
    );
  });

  test("says domination is off when it opens after the end, or when no countdown can end in time", () => {
    const off = [
      "WIN         Domination is off in this match: the highest score at the end of day 7 wins.",
    ];
    expect(win(sheet({ "time.dominationStart": 604801 }))).toEqual(off);
    // Opens at day 7 00:00 with a 24 h hold: a countdown would end at 604800 = matchEnd, which wins.
    expect(win(sheet({ "time.dominationStart": 518400 }))[0]).toStartWith(
      "WIN         From day 7:",
    );
    // One second later it could end only after matchEnd.
    expect(win(sheet({ "time.dominationStart": 518401 }))).toEqual(off);
    // A 3-day match: the default opening at day 4 is after its end.
    expect(win(sheet({ "time.matchEnd": 259200 }))).toEqual([
      "WIN         Domination is off in this match: the highest score at the end of day 3 wins.",
    ]);
    // A 4-day match: a countdown started at the opening ends exactly at matchEnd.
    expect(win(sheet({ "time.matchEnd": 345600 }))[0]).toStartWith("WIN         From day 4:");
  });

  test("SCORE has no term for taken cities", () => {
    expect(score(sheet({ "victory.dominationMinConquests": 0 }))).toEqual([
      "SCORE       100 per city + 1 per building level + 100 for Olympus",
      "            + 1 per 10 enemy pop killed (capped at 1/4 of your city points).",
    ]);
  });
});
