import { fmtTime } from "@perfidia/engine/core";
import type { CompiledRules, DeepReadonly } from "@perfidia/protocol";
import type { Perfidia11Config } from "./config_1_1.ts";
import { dominationNeed11, lastCountdownStart, mapSlots } from "./domination_1_1.ts";
import type { UnitConfig } from "./schema.ts";
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
  quadText,
} from "./text.ts";

// The cheat sheet of perfidia-1@1.1.0 (docs/rulesets/perfidia-1.md §0), rendered from the config
// for N players: 1.0.0's layout with the ids of the Greek setting, a UNITS line (the renamed units'
// roles), and the WIN line of domination by conquest, whose numbers depend on N (the threshold
// counts the map's city slots).

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

/** "35% of the 43 city slots", or the floor per player when it is the larger term. */
function thresholdText(config: Config, players: number, slots: number, cities: number): string {
  const v = config.victory;
  const share = `${perMillePercent(v.dominationPm)}% of the ${slots} city slots`;
  const byShare = dominationNeed11({ ...v, dominationMinPerPlayer: 0 }, players, slots).cities;
  return cities === byShare
    ? share
    : `${v.dominationMinPerPlayer} per player; ${share} is only ${byShare}`;
}

/** The widest line `wrapped` writes, label included. */
const WIDTH = 104;

/**
 * `text` after the label `name`, wrapped at spaces into lines of at most `WIDTH` characters; a
 * "≥" stays with the number after it.
 */
function wrapped(name: string, text: string): string[] {
  const words: string[] = [];
  for (const w of text.split(" ")) {
    const last = words.at(-1);
    if (last === "≥") words[words.length - 1] = `≥ ${w}`;
    else words.push(w);
  }
  const lines: string[] = [];
  let line = label(name);
  for (const word of words) {
    if (line.length === INDENT.length) {
      line += word;
    } else if (line.length + 1 + word.length > WIDTH) {
      lines.push(line);
      line = INDENT + word;
    } else {
      line += ` ${word}`;
    }
  }
  lines.push(line);
  return lines;
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
  const taken =
    need.taken === 0
      ? []
      : [
          `≥ ${need.taken} of them taken,`,
          "A city counts as taken when its owner conquered it and no member of the owner's bloc ever held it.",
        ];
  return wrapped(
    "WIN",
    [
      `From ${dayStart(t.dominationStart, t.day)}: a bloc (alliance or lone player) holding ≥ ${need.cities} cities (${thresholdText(config, players, slots, need.cities)}),`,
      ...taken.slice(0, 1),
      `for ${hours(t.dominationHold)} in public. The countdown must start by ${fmtTime(lastCountdownStart(t))} to end in time.`,
      ...taken.slice(1),
      `Otherwise the highest score ${end}.`,
    ].join(" "),
  );
}

/** "attacks" or "defends": the larger of a land unit's attack and defense. */
function roleOf(unit: DeepReadonly<UnitConfig>): string {
  if (unit.attack === unit.defense) return "attacks and defends";
  return unit.attack > unit.defense ? "attacks" : "defends";
}

/** "hoplite defends (atk 5, def 20, carries 10)". */
function landUnitText(id: string, x: DeepReadonly<UnitConfig>): string {
  return `${id} ${roleOf(x)} (atk ${x.attack}, def ${x.defense}, carries ${x.carry})`;
}

/** The UNITS lines: what each unit is for, with the numbers that say it. */
function unitLines(config: Config): string[] {
  const u = config.units;
  return [
    `${label("UNITS")}${landUnitText("hoplite", u.hoplite)}. ${landUnitText("peltast", u.peltast)}.`,
    `${INDENT}settler founds a city or holds a siege. transport carries ${u.transport.capacity} pop across water.`,
    `${INDENT}trireme fights only at sea (naval ${u.trireme.naval}). Only hoplites and peltasts fight on land.`,
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
    ...unitLines(config),
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
