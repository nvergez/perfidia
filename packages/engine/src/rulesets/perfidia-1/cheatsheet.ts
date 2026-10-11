import { fmtDuration, fmtTime } from "@perfidia/engine/core";
import type { CompiledRules, DeepReadonly } from "@perfidia/protocol";
import type { PerfidiaConfig, Quad } from "./config.ts";

// The cheat sheet of perfidia-1 §0, rendered from the config: with the defaults it equals §0
// verbatim, and every number follows an override. Every line keeps the §0 layout (a 12-column label).

const INDENT = " ".repeat(12);

function label(name: string): string {
  return name.padEnd(12, " ");
}

/** `v` per mille as a decimal without trailing zeros: 1500 → "1.5", 1250 → "1.25", 1000 → "1". */
function perMilleDecimal(pm: number): string {
  const whole = Math.floor(pm / 1000);
  const frac = String(pm % 1000)
    .padStart(3, "0")
    .replace(/0+$/, "");
  return frac === "" ? String(whole) : `${whole}.${frac}`;
}

/** `v` per mille as a percentage: 50 → "5", 25 → "2.5", 700 → "70". */
function perMillePercent(pm: number): string {
  const whole = Math.floor(pm / 10);
  const frac = pm % 10;
  return frac === 0 ? String(whole) : `${whole}.${frac}`;
}

/** `v` per mille as a reduced fraction: 250 → "1/4", 1000 → "all", 0 → "0". */
function perMilleFraction(pm: number): string {
  if (pm === 0) return "0";
  if (pm === 1000) return "all";
  let a = pm;
  let b = 1000;
  while (b !== 0) [a, b] = [b, a % b];
  return `${pm / a}/${1000 / a}`;
}

/**
 * `a·x² + b·x + c` as text, zero terms omitted and unit coefficients dropped: ascending
 * "50 + 20L + 5L²", descending "60L² + 280L + 660". `sep` goes between a coefficient and a word
 * variable ("20·hall").
 */
function quadText(q: DeepReadonly<Quad>, v: string, order: "asc" | "desc", sep = ""): string {
  const term = (coef: number, power: "" | "²"): string | null => {
    if (coef === 0) return null;
    if (power === "" && v === "") return String(coef);
    return `${coef === 1 ? "" : `${coef}${sep}`}${v}${power}`;
  };
  const constant = q.c === 0 ? null : String(q.c);
  const parts = [constant, term(q.b, ""), term(q.a, "²")].filter((p): p is string => p !== null);
  if (order === "desc") parts.reverse();
  return parts.length === 0 ? "0" : parts.join(" + ");
}

/** A duration in whole hours when it is one ("6 h", "24 h"), otherwise as `fmtDuration`. */
function hours(s: number): string {
  return s % 3600 === 0 ? `${s / 3600} h` : fmtDuration(s);
}

/** "day 3" for the start of a game day, otherwise the full game time. */
function dayStart(t: number, day: number): string {
  return t % day === 0 ? `day ${t / day + 1}` : fmtTime(t);
}

/** A time of the first day as "HH:MM", otherwise the full game time. */
function clock(t: number, day: number): string {
  return t < day ? fmtTime(t).slice(3) : fmtTime(t);
}

function dayCount(s: number, day: number): string {
  if (s % day !== 0) return fmtDuration(s);
  const n = s / day;
  return `${n} day${n === 1 ? "" : "s"}`;
}

function matchEndText(t: number, day: number): string {
  return t % day === 0 ? `at the end of day ${t / day}` : `at ${fmtTime(t)}`;
}

/** "Frontier ×1.5, inner/hub ×1.25, Crown ×1.5": richness multipliers other than ×1. */
function richnessText(config: DeepReadonly<PerfidiaConfig>): string {
  const k = config.map.kinds;
  const names: [string, number][] = [
    ["home", k.home.richnessPm],
    ["backyard", k.backyard.richnessPm],
    ["frontier", k.frontier.richnessPm],
    ["inner", k.inner.richnessPm],
    ["hub", k.hub.richnessPm],
    ["Crown", k.crown.richnessPm],
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

function perPlayerText(n: number): string {
  if (n === 0) return "0";
  return n === 1 ? "N" : `${n}N`;
}

/** `Ruleset.cheatSheet`: §0 rendered from the config. */
export function renderCheatSheet(
  config: DeepReadonly<PerfidiaConfig>,
  _rules: DeepReadonly<CompiledRules>,
): string {
  const t = config.time;
  const e = config.economy;
  const u = config.units;
  const c = config.combat;
  const s = config.scoring;
  const v = config.victory;
  const settler = u.settler.cost;
  const weight = quadText(e.levelWeight, "L", "desc");
  const win =
    t.dominationStart > t.matchEnd
      ? [
          `${label("WIN")}Domination is off in this match: the highest score ${matchEndText(t.matchEnd, t.day)} wins.`,
        ]
      : [
          `${label("WIN")}From ${dayStart(t.dominationStart, t.day)}: a bloc (alliance or lone player) holding ≥ ${perMillePercent(v.dominationPm)}% of all cities (and ≥ ${perPlayerText(v.dominationMinPerPlayer)})`,
          `${INDENT}for ${hours(t.dominationHold)} in public. Otherwise the highest score ${matchEndText(t.matchEnd, t.day)}.`,
        ];
  return [
    `${label("TIME")}integer game-seconds. 1 day = ${t.day}. Match = ${dayCount(t.matchEnd, t.day)} = ${t.matchEnd}.`,
    `${INDENT}No attack launches before ${clock(t.protectionEnd, t.day)} (${t.protectionEnd}). Capitals cannot be besieged before ${dayStart(t.capitalImmunityEnd, t.day)} (${t.capitalImmunityEnd}).`,
    `${label("TRAVEL")}same island: ${hours(t.sameIslandTravel)}. Other island: tiles × ${u.transport.seaPace ?? config.movement.homeboundPace} s (with transports), × ${u.warship.seaPace ?? config.movement.homeboundPace} s (warships only),`,
    `${INDENT}× ${config.movement.spyPace} s (spy, no units). Never less than ${hours(t.minTravel)}. Same time both ways. view_map lists them.`,
    `${INDENT}An incoming attack shows its origin, owner, launch and arrival times, never its units.`,
    `${INDENT}Its pace therefore shows whether it is warships only.`,
    `${INDENT}A return heading into a city you besiege shows its owner and times only, never its origin.`,
    `${label("PRODUCTION")}producer level L: ${quadText(e.production, "L", "asc")} per hour.${richnessText(config)}`,
    `${label("STORAGE")}warehouse L holds ${quadText(e.warehouseCap, "L", "desc")} of each resource. ${e.lootProtectPerLevel}·L of each is safe from loot.`,
    `${label("POPULATION")}hall H allows ${quadText(e.popCap, "H", "desc")} pop. Every unit homed in the city counts, wherever it is.`,
    `${label("BUILD")}level L costs base × (${weight}) / ${e.levelWeightDiv}. It takes baseTime × (${weight}) / (${e.buildTimeOffset} + hall) s.`,
    `${label("RECRUIT")}unit time = baseTime × ${e.recruitTimeOffset + 1} / (${e.recruitTimeOffset} + barracks or harbor level). Units arrive one by one.`,
    `${label("SETTLER")}${settler.wood} wood / ${settler.stone} stone / ${settler.gold} gold × k, where k = your cities + your settlers (k ≤ ${config.settler.scaleCap}).`,
    `${label("COMBAT")}naval phase (only across water): warships ${u.warship.naval} each. Losing it sinks the whole attack.`,
    `${INDENT}land phase: A = Σ attack  vs  D = (Σ defense + ${quadText(e.baseDefense, "hall", "asc", "·")}) × (1 + ${perMillePercent(c.wallPmPerLevel)}%·wall).`,
    `${INDENT}The defender wins ties. Morale: −${perMillePercent(c.moralePmPerCity)}% attack per city you own above the foe (floor ${perMillePercent(c.moraleFloorPm)}%).`,
    `${label("LOSSES")}The loser loses everything in that phase. The winner loses (loser/winner)² of each stack.`,
    `${INDENT}Example: winning at 2:1 costs 25%; at 3:2 it costs 44%. Below 1.41:1 a lone settler dies.`,
    `${label("AFTER A WIN")}all defenders die and the wall drops ${c.wallBreachOnLoss}. With no settler alive: loot (raider carries ${u.raider.carry}).`,
    `${INDENT}With a settler alive: a public ${hours(t.siegeDuration)} SIEGE. The city is yours at the end unless someone`,
    `${INDENT}kills every settler in your garrison first.`,
    `${label("SCORE")}${s.cityBase} per city + ${s.perBuildingLevel} per building level + ${s.crownBonus} for the Crown`,
    `${INDENT}+ 1 per ${s.killPopPerPoint} enemy pop killed (capped at ${perMilleFraction(s.killCapPm)} of your city points).`,
    ...win,
  ].join("\n");
}
