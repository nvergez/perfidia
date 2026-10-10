import { describe, expect, test } from "bun:test";
import { renderCheatSheet } from "./cheatsheet.ts";
import { compileRules } from "./compile.ts";
import { PERFIDIA_1_DEFAULTS, type PerfidiaConfig, PerfidiaConfigSchema } from "./config.ts";

// The cheat sheet equals docs/rulesets/perfidia-1.md §0 verbatim for the defaults (the block below
// is copied from the document) and follows every override.

const SECTION_0 = [
  "TIME        integer game-seconds. 1 day = 86400. Match = 7 days = 604800.",
  "            No attack launches before 12:00 (43200). Capitals cannot be besieged before day 3 (172800).",
  "TRAVEL      same island: 1 h. Other island: tiles × 60 s (with transports), × 45 s (warships only),",
  "            × 30 s (spy, no units). Never less than 1 h. Same time both ways. view_map lists them.",
  "            An incoming attack shows its origin, owner, launch and arrival times, never its units.",
  "            Its pace therefore shows whether it is warships only.",
  "PRODUCTION  producer level L: 50 + 20L + 5L² per hour. Frontier ×1.5, inner/hub ×1.25, Crown ×1.5.",
  "STORAGE     warehouse L holds 60L² + 280L + 660 of each resource. 100·L of each is safe from loot.",
  "POPULATION  hall H allows 2H² + 20H + 40 pop. Every unit homed in the city counts, wherever it is.",
  "BUILD       level L costs base × (L² + 3L + 6) / 10. It takes baseTime × (L² + 3L + 6) / (9 + hall) s.",
  "RECRUIT     unit time = baseTime × 10 / (9 + barracks or harbor level). Units arrive one by one.",
  "SETTLER     450 wood / 450 stone / 750 gold × k, where k = your cities + your settlers (k ≤ 10).",
  "COMBAT      naval phase (only across water): warships 50 each. Losing it sinks the whole attack.",
  "            land phase: A = Σ attack  vs  D = (Σ defense + 50 + 20·hall) × (1 + 5%·wall).",
  "            The defender wins ties. Morale: −10% attack per city you own above the foe (floor 70%).",
  "LOSSES      The loser loses everything in that phase. The winner loses (loser/winner)² of each stack.",
  "            Example: winning at 2:1 costs 25%; at 3:2 it costs 44%. Below 1.41:1 a lone settler dies.",
  "AFTER A WIN all defenders die and the wall drops 1. With no settler alive: loot (raider carries 50).",
  "            With a settler alive: a public 6 h SIEGE. The city is yours at the end unless someone",
  "            kills every settler in your garrison first.",
  "SCORE       100 per city + 1 per building level + 100 for the Crown",
  "            + 1 per 10 enemy pop killed (capped at 1/4 of your city points).",
  "WIN         From day 4: a bloc (alliance or lone player) holding ≥ 40% of all cities (and ≥ 2N)",
  "            for 24 h in public. Otherwise the highest score at the end of day 7.",
].join("\n");

function sheet(config: PerfidiaConfig = PERFIDIA_1_DEFAULTS, players = 8): string {
  return renderCheatSheet(config, compileRules(config, players));
}

function edited(edit: (c: PerfidiaConfig) => void): PerfidiaConfig {
  const c = PerfidiaConfigSchema.parse(structuredClone(PERFIDIA_1_DEFAULTS));
  edit(c);
  return PerfidiaConfigSchema.parse(c);
}

describe("renderCheatSheet", () => {
  test("equals §0 verbatim for the defaults, for every N", () => {
    for (let n = 6; n <= 12; n += 1) expect(sheet(PERFIDIA_1_DEFAULTS, n)).toBe(SECTION_0);
  });

  test("keeps the 12-column labels of §0", () => {
    for (const line of sheet().split("\n")) expect(line.slice(11, 12)).toBe(" ");
  });

  test("follows time overrides", () => {
    const text = sheet(
      edited((c) => {
        c.time.matchEnd = 86400;
        c.time.protectionEnd = 21600;
        c.time.capitalImmunityEnd = 3600;
        c.time.minTravel = 7200;
        c.time.sameIslandTravel = 9000;
        c.time.siegeDuration = 3600;
        c.time.dominationStart = 7200;
        c.time.dominationHold = 3600;
      }),
    );
    expect(text).toContain("Match = 1 day = 86400.");
    expect(text).toContain("No attack launches before 06:00 (21600).");
    expect(text).toContain("Capitals cannot be besieged before D1 01:00 (3600).");
    expect(text).toContain("same island: 2h30m.");
    expect(text).toContain("Never less than 2 h.");
    expect(text).toContain("a public 1 h SIEGE");
    expect(text).toContain("From D1 02:00: a bloc");
    expect(text).toContain("for 1 h in public. Otherwise the highest score at the end of day 1.");
  });

  test("says when domination is off", () => {
    const text = sheet(
      edited((c) => {
        c.time.dominationStart = 604801;
      }),
    );
    expect(text.split("\n").at(-1)).toBe(
      "WIN         Domination is off in this match: the highest score at the end of day 7 wins.",
    );
  });

  test("follows economy, combat and scoring overrides", () => {
    const text = sheet(
      edited((c) => {
        c.economy.production = { a: 0, b: 1, c: 60 };
        c.economy.warehouseCap = { a: 1, b: 0, c: 4000 };
        c.economy.lootProtectPerLevel = 150;
        c.economy.baseDefense = { a: 2, b: 0, c: 0 };
        c.economy.levelWeight = { a: 2, b: 0, c: 1 };
        c.economy.levelWeightDiv = 8;
        c.economy.recruitTimeOffset = 4;
        c.map.kinds.frontier.richnessPm = 1250;
        c.map.kinds.hub.richnessPm = 1000;
        c.map.kinds.crown.richnessPm = 2000;
        c.units.settler.cost = { wood: 400, stone: 500, gold: 600 };
        c.units.warship.naval = 60;
        c.units.raider.carry = 40;
        c.settler.scaleCap = 8;
        c.combat.wallPmPerLevel = 25;
        c.combat.moralePmPerCity = 150;
        c.combat.moraleFloorPm = 650;
        c.combat.wallBreachOnLoss = 2;
        c.scoring.killCapPm = 300;
        c.scoring.crownBonus = 50;
        c.victory.dominationPm = 455;
        c.victory.dominationMinPerPlayer = 1;
      }),
    );
    expect(text).toContain("producer level L: 60 + L per hour. Frontier/inner ×1.25, Crown ×2.");
    expect(text).toContain(
      "warehouse L holds L² + 4000 of each resource. 150·L of each is safe from loot.",
    );
    expect(text).toContain("D = (Σ defense + 2·hall²) × (1 + 2.5%·wall).");
    expect(text).toContain("level L costs base × (2L² + 1) / 8.");
    expect(text).toContain("unit time = baseTime × 5 / (4 + barracks or harbor level).");
    expect(text).toContain(
      "400 wood / 500 stone / 600 gold × k, where k = your cities + your settlers (k ≤ 8).",
    );
    expect(text).toContain("warships 60 each.");
    expect(text).toContain("Morale: −15% attack per city you own above the foe (floor 65%).");
    expect(text).toContain("the wall drops 2. With no settler alive: loot (raider carries 40).");
    expect(text).toContain("+ 50 for the Crown");
    expect(text).toContain("(capped at 3/10 of your city points)");
    expect(text).toContain("holding ≥ 45.5% of all cities (and ≥ N)");
    expect(text).not.toBe(SECTION_0);
  });

  test("is a pure function of the config", () => {
    expect(sheet()).toBe(sheet());
  });
});
