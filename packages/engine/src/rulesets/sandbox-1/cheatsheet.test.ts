import { describe, expect, test } from "bun:test";
import { renderCheatSheet } from "./cheatsheet.ts";
import { compileRules } from "./compile.ts";
import { SANDBOX_1_DEFAULTS } from "./config.ts";
import { sandboxConfig, type Overrides } from "./testkit.test.ts";

// The cheat sheet is rendered from the config and the compiled rules, never a fixed string: the
// defaults give the text below, and every number follows an override.

const DEFAULT_SHEET = [
  "TIME        integer game-seconds. 1 day = 86400. Match = 7 days = 604800.",
  "            No attack launches before 06:00 (21600). Capitals cannot be captured before day 3 (172800).",
  "MAP         a ring of 6 sectors, 40 tiles each (240 around). Each has a home island (2 slots)",
  "            and a shared island (2 slots, production ×1.5). Distance = ring distance in x + distance in y.",
  "TRAVEL      4800 + 60 s per tile for every movement; 4800 s on one island. view_map lists them.",
  "PRODUCTION  sawmill (wood), pit (stone), forge (gold): 20 per hour at level 0, 40 + 40L at level L ≥ 1.",
  "STORAGE     depot L holds 800 + 700L of each resource.",
  "POPULATION  keep L allows 50 + 40L pop. Every unit homed in the city counts, wherever it is.",
  "BUILD       level L costs 30L wood / 30L stone / 10L gold and takes 600·L s (max level 8).",
  "            camp and docks need keep 2. Requirements count completed levels only. At most 4 items queued.",
  "UNITS       spearman: attack 5, defense 15, carries 10, pop 1, 20/30/20, 240 s, camp 1.",
  "            axeman: attack 15, defense 5, carries 25, pop 1, 30/20/25, 240 s, camp 1.",
  "            colonist: pop 5, 300/300/300 × k (k = your cities + your colonists, k ≤ 6), 3600 s, camp 2.",
  "            boat: carries 15 pop of land units across water, pop 2, 100/30/50, 900 s, docks 1.",
  "RECRUIT     camp and docks: up to 4 batches of 300 units (colonists 1 per order). A batch arrives whole at its end.",
  "            Cancelling refunds 100% of queued items and 50% of the item in progress.",
  "COMBAT      land only. A = Σ attack  vs  D = Σ defense of every land unit in the city that is not yours + 10·keep.",
  "            The attacker wins if A > D. The loser's land units all die; the winner loses (loser/winner)² of each stack.",
  "            Boats never fight: the defender's boats sink if it loses, the attacker's always sail home.",
  "AFTER A WIN with a colonist alive the city is yours at once (a capital only from day 3): 1 colonist settles,",
  "            everything homed in the city is disbanded and its queues are lost. Otherwise the survivors loot",
  "            up to 50% of each resource, as much as they carry.",
  "SPY         needs ≥ 50 gold; succeeds if gold > 50 + pop of the land units in the city. A failure tells the owner.",
  "RECALL      only supports, within 15m of launch; stationed groups go home whole. No dismissal.",
  "DIPLOMACY   alliances of up to 3; 1 pact without expiry; 2 open proposals, each for 6h.",
  "SCORE       50 per city + 2 per building level.",
  "WIN         From day 3: a player owning ≥ 50% of all cities (rounded up, and ≥ 2) wins at once.",
  "            The last player standing wins. Otherwise the highest score at the end of day 7 (ties: cities, then player number).",
].join("\n");

function sheet(overrides: Overrides, players = 6): string {
  const config = sandboxConfig(overrides);
  return renderCheatSheet(config, compileRules(config, players));
}

describe("cheat sheet", () => {
  test("the defaults render the reference text", () => {
    expect(renderCheatSheet(SANDBOX_1_DEFAULTS, compileRules(SANDBOX_1_DEFAULTS, 6))).toBe(
      DEFAULT_SHEET,
    );
  });

  test("follows N", () => {
    expect(sheet({}, 12)).toContain("a ring of 12 sectors, 40 tiles each (480 around)");
    expect(sheet({}, 2)).toContain("a ring of 2 sectors, 40 tiles each (80 around)");
  });

  test("follows every overridden number", () => {
    const s = sheet({
      "time.matchEnd": 86400,
      "time.attackFrom": 0,
      "time.minTravel": 6000,
      "time.hillOpen": 3600,
      "time.capitalImmunityEnd": 90000,
      "travel.perTile": 30,
      "economy.militaryKeep": 0,
      "units.colonist.scaleCap": 3,
      "combat.lootPm": 250,
      "diplomacy.pactDuration": 172800,
      "diplomacy.maxPacts": 2,
      "victory.hillPm": 667,
    });
    expect(s).toContain("Match = 1 day = 86400.");
    expect(s).toContain("No attack launches before 00:00 (0).");
    expect(s).toContain("before D2 01:00 (90000)");
    expect(s).toContain("6000 + 30 s per tile for every movement; 6000 s on one island.");
    expect(s).not.toContain("camp and docks need keep");
    expect(s).toContain("k ≤ 3");
    expect(s).toContain("up to 25% of each resource");
    expect(s).toContain("2 pacts of 2d;");
    expect(s).toContain("From D1 01:00: a player owning ≥ 66.7% of all cities");
    expect(s).toContain("at the end of day 1");
  });

  test("never renders a missing number", () => {
    for (let n = 2; n <= 12; n += 1) {
      expect(sheet({}, n)).not.toMatch(/undefined|NaN|null|\?/);
    }
  });
});
