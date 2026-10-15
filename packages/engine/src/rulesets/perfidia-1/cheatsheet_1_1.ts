import type { CompiledRules, DeepReadonly } from "@perfidia/protocol";
import type { Perfidia11Config } from "./config_1_1.ts";
import { dominationNeed11, mapSlots } from "./domination_1_1.ts";
import {
  clock,
  dayCount,
  dayStart,
  hours,
  INDENT,
  label,
  matchEndText,
  perMilleDecimal,
  perMilleFraction,
  perMillePercent,
  perPlayerText,
  quadText,
} from "./text.ts";

// The cheat sheet of perfidia-1@1.1.0 (docs/rulesets/perfidia-1.md §0), rendered from the config
// for N players: 1.0.0's layout with the ids of the Greek setting, and the WIN line of domination
// by conquest, whose numbers depend on N (the threshold counts the map's city slots).

type Config = DeepReadonly<Perfidia11Config>;

/** "Frontier ×1.5, inner/hub ×1.25, Olympus ×1.5": richness multipliers other than ×1. */
function richnessText(config: Config): string {
  const k = config.map.kinds;
  const names: [string, number][] = [
    ["home", k.home.richnessPm],
    ["backyard", k.backyard.richnessPm],
    ["frontier", k.frontier.richnessPm],
    ["inner", k.inner.richnessPm],
    ["hub", k.hub.richnessPm],
    ["Olympus", k.olympus.richnessPm],
  ];
  const groups: { names: string[]; pm: number }[] = [];
  for (const [name, pm] of names) {
    if (pm === 1000) continue;
    const last = groups.at(-1);
    if (last !== undefined && last.pm === pm) {
      last.names.push(name);
    } else {
      groups.push({ names: [name], pm });
    }
  }
  if (groups.length === 0) return "";
  const text = groups.map((g) => `${g.names.join("/")} ×${perMilleDecimal(g.pm)}`).join(", ");
  return ` ${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/** Whether a countdown can end by `matchEnd` (a countdown ending at `matchEnd` still wins). */
function dominationOn(config: Config): boolean {
  const t = config.time;
  return t.dominationStart <= t.matchEnd && t.dominationStart + t.dominationHold <= t.matchEnd;
}

/** The WIN lines for N players. */
function winLines(config: Config, players: number): string[] {
  const t = config.time;
  const v = config.victory;
  const end = matchEndText(t.matchEnd, t.day);
  if (!dominationOn(config)) {
    return [`${label("WIN")}Domination is off in this match: the highest score ${end} wins.`];
  }
  const slots = mapSlots(config, players);
  const need = dominationNeed11(v, players, slots);
  const first = `${label("WIN")}From ${dayStart(t.dominationStart, t.day)}: a bloc (alliance or lone player) holding ≥ ${need.cities} cities (${perMillePercent(v.dominationPm)}% of the ${slots} city slots,`;
  const floor = `and ≥ ${perPlayerText(v.dominationMinPerPlayer)})`;
  const hold = `for ${hours(t.dominationHold)} in public.`;
  if (need.taken === 0) {
    return [first, `${INDENT}${floor}, ${hold} Otherwise the highest score ${end}.`];
  }
  return [
    first,
    `${INDENT}${floor}, ≥ ${need.taken} of them taken, ${hold} A city is taken when its owner conquered`,
    `${INDENT}it and never held it before. Otherwise the highest score ${end}.`,
  ];
}

/** The SCORE lines. */
function scoreLines(config: Config): string[] {
  const s = config.scoring;
  return [
    `${label("SCORE")}${s.cityBase} per city + ${s.perBuildingLevel} per building level + ${s.olympusBonus} for Olympus`,
    `${INDENT}+ 1 per ${s.killPopPerPoint} enemy pop killed (capped at ${perMilleFraction(s.killCapPm)} of your city points).`,
  ];
}

/** `Ruleset.cheatSheet` of 1.1.0: §0 rendered from the config for `rules.players` players. */
export function renderCheatSheet11(config: Config, rules: DeepReadonly<CompiledRules>): string {
  const t = config.time;
  const e = config.economy;
  const u = config.units;
  const c = config.combat;
  const settler = u.settler.cost;
  const weight = quadText(e.levelWeight, "L", "desc");
  return [
    `${label("TIME")}integer game-seconds. 1 day = ${t.day}. Match = ${dayCount(t.matchEnd, t.day)} = ${t.matchEnd}.`,
    `${INDENT}No attack launches before ${clock(t.protectionEnd, t.day)} (${t.protectionEnd}). Capitals cannot be besieged before ${dayStart(t.capitalImmunityEnd, t.day)} (${t.capitalImmunityEnd}).`,
    `${label("TRAVEL")}same island: ${hours(t.sameIslandTravel)}. Other island: tiles × ${u.transport.seaPace ?? config.movement.homeboundPace} s (with transports), × ${u.trireme.seaPace ?? config.movement.homeboundPace} s (triremes only),`,
    `${INDENT}× ${config.movement.spyPace} s (spy, no units). Never less than ${hours(t.minTravel)}. Same time both ways. view_map lists them.`,
    `${INDENT}An incoming attack shows its origin, owner, launch and arrival times, never its units.`,
    `${INDENT}Its pace therefore shows whether it is triremes only.`,
    `${INDENT}A return heading into a city you besiege shows its owner and times only, never its origin.`,
    `${label("PRODUCTION")}producer level L: ${quadText(e.production, "L", "asc")} per hour.${richnessText(config)}`,
    `${label("STORAGE")}warehouse L holds ${quadText(e.warehouseCap, "L", "desc")} of each resource. ${e.lootProtectPerLevel}·L of each is safe from loot.`,
    `${label("POPULATION")}acropolis L allows ${quadText(e.popCap, "L", "desc")} pop. Every unit homed in the city counts, wherever it is.`,
    `${label("BUILD")}level L costs base × (${weight}) / ${e.levelWeightDiv}. It takes baseTime × (${weight}) / (${e.buildTimeOffset} + acropolis) s.`,
    `${label("RECRUIT")}unit time = baseTime × ${e.recruitTimeOffset + 1} / (${e.recruitTimeOffset} + barracks or harbor level). Units arrive one by one.`,
    `${label("SETTLER")}${settler.wood} wood / ${settler.stone} stone / ${settler.gold} gold × k, where k = your cities + your settlers (k ≤ ${config.settler.scaleCap}).`,
    `${label("COMBAT")}naval phase (only across water): triremes ${u.trireme.naval} each. Losing it sinks the whole attack.`,
    `${INDENT}land phase: A = Σ attack  vs  D = (Σ defense + ${quadText(e.baseDefense, "acropolis", "asc", "·")}) × (1 + ${perMillePercent(c.wallPmPerLevel)}%·wall).`,
    `${INDENT}The defender wins ties. Morale: −${perMillePercent(c.moralePmPerCity)}% attack per city you own above the foe (floor ${perMillePercent(c.moraleFloorPm)}%).`,
    `${label("LOSSES")}The loser loses everything in that phase. The winner loses (loser/winner)² of each stack.`,
    `${INDENT}Example: winning at 2:1 costs 25%; at 3:2 it costs 44%. Below 1.41:1 a lone settler dies.`,
    `${label("AFTER A WIN")}all defenders die and the wall drops ${c.wallBreachOnLoss}. With no settler alive: loot (peltast carries ${u.peltast.carry}).`,
    `${INDENT}With a settler alive: a public ${hours(t.siegeDuration)} SIEGE. The city is yours at the end unless someone`,
    `${INDENT}kills every settler in your garrison first.`,
    ...scoreLines(config),
    ...winLines(config, rules.players),
  ].join("\n");
}
