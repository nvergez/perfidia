import { DAY, fmtDuration, fmtTime } from "@perfidia/engine/core";
import type { CompiledRules, DeepReadonly, Res } from "@perfidia/protocol";
import type { SandboxConfig } from "./config.ts";
import { ringWidth } from "./map.ts";

// The cheat sheet of sandbox-1, rendered from the config and the compiled rules (never a fixed
// string): every number follows an override, and the map line follows N. Each line keeps a
// 12-column label, like perfidia-1's.

const INDENT = " ".repeat(12);

function label(name: string): string {
  return name.padEnd(12, " ");
}

/** `v` per mille as a percentage: 500 → "50", 25 → "2.5". */
function percent(pm: number): string {
  const whole = Math.floor(pm / 10);
  const frac = pm % 10;
  return frac === 0 ? String(whole) : `${whole}.${frac}`;
}

/** `v` per mille as a multiplier: 1500 → "1.5", 1000 → "1". */
function multiplier(pm: number): string {
  const whole = Math.floor(pm / 1000);
  const frac = String(pm % 1000)
    .padStart(3, "0")
    .replace(/0+$/, "");
  return frac === "" ? String(whole) : `${whole}.${frac}`;
}

/** "day 3" for the start of a game day, otherwise the full game time. */
function dayStart(t: number): string {
  return t % DAY === 0 ? `day ${t / DAY + 1}` : fmtTime(t);
}

/** A time of the first day as "HH:MM", otherwise the full game time. */
function clock(t: number): string {
  return t < DAY ? fmtTime(t).slice(3) : fmtTime(t);
}

function dayCount(s: number): string {
  if (s % DAY !== 0) return fmtDuration(s);
  const n = s / DAY;
  return `${n} day${n === 1 ? "" : "s"}`;
}

function matchEndText(t: number): string {
  return t % DAY === 0 ? `at the end of day ${t / DAY}` : `at ${fmtTime(t)}`;
}

function cost(r: DeepReadonly<Res>): string {
  return `${r.wood}/${r.stone}/${r.gold}`;
}

function linear(base: number, perLevel: number, v: string): string {
  if (perLevel === 0) return String(base);
  const term = `${perLevel === 1 ? "" : perLevel}${v}`;
  return base === 0 ? term : `${base} + ${term}`;
}

function needs(building: string, level: number): string {
  return level > 0 ? `, ${building} ${level}` : "";
}

/** `Ruleset.cheatSheet`. */
export function renderCheatSheet(
  config: DeepReadonly<SandboxConfig>,
  rules: DeepReadonly<CompiledRules>,
): string {
  const t = config.time;
  const m = config.map;
  const e = config.economy;
  const u = config.units;
  const q = config.queues;
  const d = config.diplomacy;
  const n = rules.players;
  const keepNeed = e.militaryKeep > 0 ? `camp and docks need keep ${e.militaryKeep}. ` : "";
  const pacts = `${d.maxPacts} pact${d.maxPacts === 1 ? "" : "s"} ${d.pactDuration === null ? "without expiry" : `of ${fmtDuration(d.pactDuration)}`}`;
  return [
    `${label("TIME")}integer game-seconds. 1 day = ${DAY}. Match = ${dayCount(t.matchEnd)} = ${t.matchEnd}.`,
    `${INDENT}No attack launches before ${clock(t.attackFrom)} (${t.attackFrom}). Capitals cannot be captured before ${dayStart(t.capitalImmunityEnd)} (${t.capitalImmunityEnd}).`,
    `${label("MAP")}a ring of ${n} sectors, ${m.sectorWidth} tiles each (${ringWidth(config, n)} around). Each has a home island (${m.home.slots} slots)`,
    `${INDENT}and a shared island (${m.shared.slots} slots, production ×${multiplier(m.shared.richnessPm)}). Distance = ring distance in x + distance in y.`,
    `${label("TRAVEL")}${t.minTravel} + ${config.travel.perTile} s per tile for every movement; ${t.minTravel} s on one island. view_map lists them.`,
    `${label("PRODUCTION")}sawmill (wood), pit (stone), forge (gold): ${e.production.level0} per hour at level 0, ${linear(e.production.base, e.production.perLevel, "L")} at level L ≥ 1.`,
    `${label("STORAGE")}depot L holds ${linear(e.storage.base, e.storage.perLevel, "L")} of each resource.`,
    `${label("POPULATION")}keep L allows ${linear(e.population.base, e.population.perLevel, "L")} pop. Every unit homed in the city counts, wherever it is.`,
    `${label("BUILD")}level L costs ${e.buildCost.wood}L wood / ${e.buildCost.stone}L stone / ${e.buildCost.gold}L gold and takes ${e.buildTime}·L s (max level ${e.maxLevel}).`,
    `${INDENT}${keepNeed}Requirements count completed levels only. At most ${q.buildMax} items queued.`,
    `${label("UNITS")}spearman: attack ${u.spearman.attack}, defense ${u.spearman.defense}, carries ${u.spearman.carry}, pop ${u.spearman.pop}, ${cost(u.spearman.cost)}, ${u.spearman.time} s${needs("camp", u.spearman.camp)}.`,
    `${INDENT}axeman: attack ${u.axeman.attack}, defense ${u.axeman.defense}, carries ${u.axeman.carry}, pop ${u.axeman.pop}, ${cost(u.axeman.cost)}, ${u.axeman.time} s${needs("camp", u.axeman.camp)}.`,
    `${INDENT}colonist: pop ${u.colonist.pop}, ${cost(u.colonist.cost)} × k (k = your cities + your colonists, k ≤ ${u.colonist.scaleCap}), ${u.colonist.time} s${needs("camp", u.colonist.camp)}.`,
    `${INDENT}boat: carries ${u.boat.capacity} pop of land units across water, pop ${u.boat.pop}, ${cost(u.boat.cost)}, ${u.boat.time} s${needs("docks", u.boat.docks)}.`,
    `${label("RECRUIT")}camp and docks: up to ${q.recruitBatches} batches of ${q.batchMax} units (colonists ${u.colonist.maxPerOrder} per order). A batch arrives whole at its end.`,
    `${INDENT}Cancelling refunds ${percent(q.refundQueuedPm)}% of queued items and ${percent(q.refundActivePm)}% of the item in progress.`,
    `${label("COMBAT")}land only. A = Σ attack  vs  D = Σ defense of every land unit in the city that is not yours + ${config.combat.keepDefense}·keep.`,
    `${INDENT}The attacker wins if A > D. The loser's land units all die; the winner loses (loser/winner)² of each stack.`,
    `${INDENT}Boats never fight: the defender's boats sink if it loses, the attacker's always sail home.`,
    `${label("AFTER A WIN")}with a colonist alive the city is yours at once (a capital only from ${dayStart(t.capitalImmunityEnd)}): 1 colonist settles,`,
    `${INDENT}everything homed in the city is disbanded and its queues are lost. Otherwise the survivors loot`,
    `${INDENT}up to ${percent(config.combat.lootPm)}% of each resource, as much as they carry.`,
    `${label("SPY")}needs ≥ ${config.spy.minGold} gold; succeeds if gold > ${config.spy.counterBase} + pop of the land units in the city. A failure tells the owner.`,
    `${label("RECALL")}only supports, within ${fmtDuration(config.movement.recallWindow)} of launch; stationed groups go home whole. No dismissal.`,
    `${label("DIPLOMACY")}alliances of up to ${d.allianceMax}; ${pacts}; ${d.maxOpenProposals} open proposals, each for ${fmtDuration(d.proposalTtl)}.`,
    `${label("SCORE")}${config.score.perCity} per city + ${config.score.perLevel} per building level.`,
    `${label("WIN")}From ${dayStart(t.hillOpen)}: a player owning ≥ ${percent(config.victory.hillPm)}% of all cities (rounded up, and ≥ ${config.victory.hillMinCities}) wins at once.`,
    `${INDENT}The last player standing wins. Otherwise the highest score ${matchEndText(t.matchEnd)} (ties: cities, then player number).`,
  ].join("\n");
}
