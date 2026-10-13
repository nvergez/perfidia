// `opportunist@2` (docs/architecture.md §11.2): ally first, betray later, like opportunist@1
// (`opportunist.ts`, frozen), with these changes:
// - It never betrays while its own bloc runs a domination countdown, nor while its bloc is within
//   reach of the threshold (it waits for the countdown instead). A rival bloc's countdown is broken
//   by force: a strike on that bloc's weakest city (`relief.ts`), a pact partner included.
// - Real raids: it spies the nearest strangers (no alliance, no pact; never a besieged city or one
//   the hints avoid) and raids the weakest on a fresh report when its army beats the estimated
//   defense by a seeded margin, leaving a city that beat it alone for a seeded cooldown.
// - Allies with fighters: on day 1 it courts its nearest neighbours as opportunist@1 does; while it
//   has no ally from day 2 on, it proposes an alliance to a neighbour seen attacking (the public
//   battle headlines), the nearest of them first, then to its nearest neighbour; it accepts an
//   alliance from anyone while it has none.
// - It relieves its own and its ally's besieged cities, supports its ally's threatened cities and
//   paces its own wakes (`pace.ts`).
// - Betrayal timing stays seeded (day 3 to 5, while it ranks in the top 2).
//
// Memory: opportunist@1's flags (`pr`, `tr`, `bt`, `s<city>`), plus `f<seat>` (when that player was
// last seen attacking), `pf` (its last alliance proposal), `l<city>` (a raid lost there), `rv<city>`
// (a spy for a raid) and the relief module's.

import { compareIds, type CityView, type PlayerId, type ToolCall } from "@perfidia/protocol";
import { call, countOf, landPop, res, unitsInReport } from "../kit.ts";
import { paceBuilds, paceRecruits } from "../pace.ts";
import { mainCity, nearby, type Planner } from "../plan.ts";
import {
  besiegedRows,
  countdownReads,
  dominationNeed,
  holdSieges,
  moraleVs,
  ownCountdown,
  reliefParams,
  reliefReads,
  relieveSieges,
  seenDefense,
  spiedDefense,
  stopTheLeader,
  supportAllies,
} from "../relief.ts";
import { randInt, type BotRng } from "../rng.ts";
import type { OtherCity, OwnCity, World } from "../world.ts";
import type { StrategyDef } from "./strategy.ts";

export interface Opportunist2Params {
  /** Game day index (0 = D1) from which it may betray: 2..4, i.e. D3..D5. */
  readonly betrayDay: number;
  /** Attack the ally's city when strength ≥ estimated defense × marginPm / 1000. */
  readonly marginPm: number;
  readonly tribute: number;
  /** Proposes an alliance (rather than a pact) to its nearest neighbour on day 1. */
  readonly allianceFirst: boolean;
  readonly neighbours: number;
  /** Intel older than this is refreshed by a spy before betraying or raiding. */
  readonly stale: number;
  readonly spyMult: number;
  /** Raid when the attack (morale applied) ≥ estimated defense × raidPm / 1000. */
  readonly raidPm: number;
  /** Fewest attackers worth a raid. */
  readonly minRaiders: number;
  /** A city that beat a raid is left alone this long. */
  readonly cooldown: number;
  /** Spies for raids per game day at most. */
  readonly spiesPerDay: number;
}

export function opportunist2Params(rng: BotRng): Opportunist2Params {
  // opportunist@1's draws first, in the same order.
  const betrayDay = randInt(rng, 2, 4);
  const marginPm = randInt(rng, 1100, 1400);
  const gift = randInt(rng, 50, 150);
  const allianceFirst = randInt(rng, 0, 1) === 1;
  const stale = randInt(rng, 14400, 28800);
  const spyMult = randInt(rng, 2, 4);
  return {
    betrayDay,
    marginPm,
    tribute: gift,
    allianceFirst,
    neighbours: 3,
    stale,
    spyMult,
    raidPm: 0,
    minRaiders: 0,
    cooldown: 0,
    spiesPerDay: 0,
  };
}

/** The raid parameters, drawn after the knobs (so that the economy draws match opportunist@1's). */
function raidParams(rng: BotRng, base: Opportunist2Params): Opportunist2Params {
  return {
    ...base,
    raidPm: randInt(rng, 1400, 1800),
    minRaiders: randInt(rng, 15, 30),
    cooldown: randInt(rng, 36000, 64800),
    spiesPerDay: randInt(rng, 3, 5),
  };
}

/** Friend cities read (and so weighed for a betrayal) per turn. */
const FRIEND_SCAN = 3;
/** Raid targets read (and weighed) per turn. */
const RAID_SCAN = 4;
/** A player seen attacking within this long counts as a fighter. */
const FIGHTER_MEMORY = 2 * 86400;
/** Its bloc within this many cities of the threshold waits for a countdown instead of betraying. */
const NEAR_THRESHOLD = 2;

const isPlayerId = (v: unknown): v is PlayerId => typeof v === "string" && /^p[1-9][0-9]*$/.test(v);

const seatNumber = (p: PlayerId): number | null => {
  const m = /^p([1-9][0-9]*)$/.exec(p);
  return m?.[1] === undefined ? null : Number(m[1]);
};

function home(w: World): OwnCity | null {
  return w.cities.find((c) => c.capital) ?? w.cities[0] ?? null;
}

/** Other players nearest to the seat's capital, by the travel time to their capital. */
function neighbours(w: World): PlayerId[] {
  const from = home(w);
  if (from === null) return [];
  return w.others
    .filter(
      (o): o is OtherCity & { capitalOf: PlayerId } =>
        o.capitalOf !== null && o.owner === o.capitalOf,
    )
    .map((o) => ({ p: o.capitalOf, travel: w.travel(from.id, o.island, false) }))
    .filter((x): x is { p: PlayerId; travel: number } => x.travel !== null)
    .toSorted((a, b) => a.travel - b.travel || compareIds(a.p, b.p))
    .map((x) => x.p);
}

/** Cities of the seat's allies and pact partners, nearest to its main city first, not besieged. */
function friendCities(w: World): OtherCity[] {
  const from = mainCity(w);
  if (from === null) return [];
  const sieged = besiegedRows(w);
  return nearby(w, from, (o) => o.owner !== null && w.relations.has(o.owner) && !sieged.has(o.id));
}

/** Cities of players the seat has no relation with, not besieged, nearest to `from` first. */
function strangerCities(w: World, from: OwnCity): OtherCity[] {
  const sieged = besiegedRows(w);
  return nearby(w, from, (o) => o.owner !== null && !w.relations.has(o.owner) && !sieged.has(o.id));
}

function topTwo(w: World): boolean {
  const me = w.board?.standings.find((s) => s.player === w.seat);
  return me !== undefined && me.rank <= 2;
}

function weighable(w: World, view: CityView | undefined): view is CityView {
  return view !== undefined && (view.tag === null || !w.hints.avoidTags.includes(view.tag));
}

/**
 * The estimated defense of a friend's city: seen in full (an ally's), its units and supports behind
 * its base defense and wall; known through reports (a pact partner's), the latest fresh spy report.
 */
function friendDefense(w: World, view: CityView, stale: number): number | null {
  if (view.access === "public") return spiedDefense(w, view, stale)?.d ?? null;
  return seenDefense(w, view);
}

// Diplomacy.

function remember(p: Planner): void {
  const { w } = p;
  for (const [player, kind] of [...w.relations.entries()].toSorted((a, b) =>
    compareIds(a[0], b[0]),
  )) {
    const label = kind === "ally" ? "ally" : "pact";
    const prefix = `${label} ${player} since `;
    if (!p.memory.m.some((line) => line.startsWith(prefix))) p.memo(`${prefix}D${w.day + 1}`);
  }
}

/** Remembers who attacked whom in the public battle headlines (`f<seat>`: last seen attacking). */
function watchFighters(p: Planner): void {
  const { w } = p;
  for (const e of [...w.briefing.news, ...w.briefing.events]) {
    if (e.type !== "battle") continue;
    const attacker = e["attacker"];
    if (!isPlayerId(attacker) || attacker === w.seat) continue;
    const n = seatNumber(attacker);
    if (n !== null) p.setFlag(`f${n}`, w.t);
  }
}

function court(p: Planner, prm: Opportunist2Params): void {
  const { w } = p;
  if (w.day !== 0 || p.flag("pr") !== null) return;
  const d = w.kit.rules.diplomacy;
  const open = w.briefing.proposals.filter((q) => q.from === w.seat).length;
  let slots = Math.max(0, d.maxOpenProposals - open);
  let pacts = [...w.relations.values()].filter((k) => k === "pact").length;
  let allied = w.self?.alliance !== null && w.self?.alliance !== undefined;
  for (const [i, player] of neighbours(w).slice(0, prm.neighbours).entries()) {
    if (slots <= 0) break;
    if (w.relations.has(player)) continue;
    if (i === 0 && prm.allianceFirst && !allied && d.allianceMax >= 2) {
      p.propose(player, "alliance", "Let us stand together.", `League ${w.seat}`);
      allied = true;
    } else if (pacts < d.maxPacts) {
      p.propose(player, "pact", "Peace between us?", null);
      pacts += 1;
    } else {
      continue;
    }
    slots -= 1;
  }
  p.setFlag("pr", w.day + 1);
}

/**
 * From day 2, while it has no ally and no alliance offer of its own is open: proposes an alliance
 * to a neighbour seen attacking within two days (the nearest), else to its nearest neighbour; at
 * most once per proposal lifetime, never to a player it betrayed.
 */
function courtFighter(p: Planner): void {
  const { w } = p;
  const d = w.kit.rules.diplomacy;
  if (w.day < 1 || d.allianceMax < 2) return;
  if (w.self?.alliance !== null && w.self?.alliance !== undefined) return;
  const mine = w.briefing.proposals.filter((q) => q.from === w.seat);
  if (mine.some((q) => q.kind === "alliance") || mine.length >= d.maxOpenProposals) return;
  const last = p.flag("pf");
  if (last !== null && w.t - last < d.proposalTtl) return;
  const betrayed = new Set(
    p.memory.m.filter((l) => l.startsWith("betray ")).map((l) => l.split(" ")[1] ?? ""),
  );
  // A player that let an offer expire within two days is not asked again yet.
  const asked = (q: PlayerId): boolean => {
    const n = seatNumber(q);
    const at = n === null ? null : p.flag(`pd${n}`);
    return at !== null && w.t - at < FIGHTER_MEMORY;
  };
  const order = neighbours(w).filter(
    (q) => !betrayed.has(q) && w.relations.get(q) !== "ally" && !asked(q),
  );
  const fighter = (q: PlayerId): boolean => {
    const n = seatNumber(q);
    const seen = n === null ? null : p.flag(`f${n}`);
    return seen !== null && w.t - seen < FIGHTER_MEMORY;
  };
  const pick = order.find(fighter) ?? order[0];
  if (pick === undefined) return;
  p.propose(
    pick,
    "alliance",
    "Two armies are stronger than one: let us stand together.",
    `League ${w.seat}`,
  );
  p.setFlag("pf", w.t);
  const n = seatNumber(pick);
  if (n !== null) p.setFlag(`pd${n}`, w.t);
  p.memo(`court ${pick}${fighter(pick) ? " (fighter)" : ""} D${w.day + 1}`);
}

function tribute(p: Planner, prm: Opportunist2Params): void {
  const { w } = p;
  if (w.day > 1 || p.flag("tr") !== null || w.board === null) return;
  const ship = w.kit.rules.movement.shipment;
  const from = home(w);
  if (ship === null || from === null || from.blocked) return;
  const strongest = w.board.standings
    .toSorted((a, b) => a.rank - b.rank)
    .find((s) => s.player !== w.seat && s.alive);
  if (strongest === undefined) return;
  const cities = w.others.filter((o) => o.owner === strongest.player);
  const to = cities.find((o) => o.capitalOf === strongest.player) ?? cities[0];
  if (to === undefined) return;
  const level = from.levels?.[ship.building] ?? 0;
  const amount = Math.min(prm.tribute, Math.floor((ship.base + ship.perLevel * level) / 3));
  const s = p.stockOf(from.id);
  if (amount <= 0 || Math.min(s.wood, s.stone, s.gold) < amount * 3) return;
  p.ship(from, to.id, res(amount, amount, amount));
  p.setFlag("tr", w.day + 1);
}

// Betrayal.

/** True while its own bloc runs a countdown or holds nearly enough cities for one. */
function dominationInReach(w: World): boolean {
  if (ownCountdown(w) !== null) return true;
  const need = dominationNeed(w);
  if (need === null) return false;
  const bloc = new Set<PlayerId>([w.seat]);
  for (const [q, kind] of w.relations) if (kind === "ally") bloc.add(q);
  let cities = 0;
  for (const c of w.map?.cities ?? []) if (c.owner !== null && bloc.has(c.owner)) cities += 1;
  return bloc.size > 1 && cities + NEAR_THRESHOLD >= need;
}

function betray(p: Planner, prm: Opportunist2Params): void {
  const { w } = p;
  if (w.day < prm.betrayDay || p.flag("bt") !== null || !topTwo(w)) return;
  if (w.t < w.kit.rules.time.attackFrom || p.attacksLeft <= 0 || dominationInReach(w)) return;
  const main = mainCity(w);
  if (main === null) return;
  for (const target of friendCities(w).slice(0, FRIEND_SCAN)) {
    const view = w.views.get(target.id);
    if (!weighable(w, view) || target.owner === null) continue;
    const est = friendDefense(w, view, prm.stale);
    if (est === null) continue;
    const group = p.attackGroup(main, target.island, 0);
    if (group === null) continue;
    const a = Math.floor((group.strength * moraleVs(w, target.owner)) / 1000);
    if (a * 1000 <= est * prm.marginPm) continue;
    p.message([target.owner], "we remain friends");
    if (p.attack(main, target.id, group.units)) {
      p.setFlag("bt", w.day + 1);
      p.memo(`betray ${target.owner} D${w.day + 1}`);
    }
    return;
  }
}

/** Spies a friend's city known only through reports, from the day before the betrayal on. */
function scoutFriends(p: Planner, prm: Opportunist2Params): void {
  const { w } = p;
  if (w.day < prm.betrayDay - 1 || p.flag("bt") !== null || !topTwo(w)) return;
  if (dominationInReach(w)) return;
  const main = mainCity(w);
  if (main === null) return;
  const kit = w.kit;
  for (const target of friendCities(w).slice(0, FRIEND_SCAN)) {
    const view = w.views.get(target.id);
    if (!weighable(w, view) || view.access !== "public") continue;
    if (spiedDefense(w, view, prm.stale) !== null || p.inFlight("spy", target.id)) continue;
    const flag = `s${target.id}`;
    const last = p.flag(flag);
    if (last !== null && w.t - last < prm.stale) continue;
    if (p.attackGroup(main, target.island, 0) === null) continue;
    const seen = view.intel === null ? null : landPop(kit, unitsInReport(kit, view.intel.data));
    const gold = p.spyGold(main, prm.spyMult, seen);
    if (gold === null) return;
    p.spy(main, target.id, gold);
    p.setFlag(flag, w.t);
    return;
  }
}

// Raids.

/** Remembers a raid lost on a city (its latest report), for the cooldown. */
function noteLosses(p: Planner): void {
  const { w } = p;
  for (const view of w.views.values()) {
    if (view.access !== "public" || view.intel === null) continue;
    const { type, data, at } = view.intel;
    if (type !== "battle_report" || data["attacker"] !== w.seat || data["winner"] === "attacker") {
      continue;
    }
    const flag = `l${view.id}`;
    if ((p.flag(flag) ?? -1) < at[0]) p.setFlag(flag, at[0]);
  }
}

/** Spies sent for raids today (flags `rv<city>` set today). */
function raidSpiesToday(p: Planner): number {
  const start = p.w.day * 86400;
  return Object.entries(p.memory.x).filter(([k, v]) => k.startsWith("rv") && v >= start).length;
}

/**
 * Raids the weakest stranger city on a fresh spy report when the army at home in the main city
 * beats its estimated defense by `raidPm`; else spies the nearest stranger whose intel is stale
 * (one a turn, a few a day).
 */
function raid(p: Planner, prm: Opportunist2Params): void {
  const { w } = p;
  const kit = w.kit;
  if (w.t < kit.rules.time.attackFrom || p.attacksLeft <= 0) return;
  const main = mainCity(w);
  if (main === null || countOf(p.homeOf(main.id), kit.roles.attacker) < prm.minRaiders) return;
  const cands = strangerCities(w, main).slice(0, RAID_SCAN);
  let best: { target: OtherCity; d: number; units: Record<string, number> } | null = null;
  for (const target of cands) {
    const view = w.views.get(target.id);
    if (!weighable(w, view) || target.owner === null) continue;
    const lost = p.flag(`l${target.id}`);
    if (lost !== null && w.t - lost < prm.cooldown) continue;
    const travel = w.travel(main.id, target.island, false) ?? 0;
    const spied = spiedDefense(w, view, prm.stale, travel);
    if (spied === null) continue;
    const group = p.attackGroup(main, target.island, 0);
    if (group === null) continue;
    const a = Math.floor((group.strength * moraleVs(w, target.owner)) / 1000);
    if (a * 1000 < spied.d * prm.raidPm) continue;
    if (best === null || spied.d < best.d) best = { target, d: spied.d, units: group.units };
  }
  if (best !== null) {
    if (p.attack(main, best.target.id, best.units)) {
      p.memo(`raid ${best.target.id} (${best.target.owner ?? "?"}) D${w.day + 1}`);
    }
    return;
  }
  // The day's spies are spread over the day, so that raids are too.
  const into = w.t - w.day * 86400;
  const allowed = Math.ceil((prm.spiesPerDay * (into + 1)) / 86400);
  if (raidSpiesToday(p) >= Math.min(prm.spiesPerDay, allowed)) return;
  for (const target of cands) {
    const view = w.views.get(target.id);
    if (!weighable(w, view) || view.access !== "public") continue;
    if (spiedDefense(w, view, prm.stale) !== null || p.inFlight("spy", target.id)) continue;
    const lost = p.flag(`l${target.id}`);
    if (lost !== null && w.t - lost < prm.cooldown) continue;
    const last = p.flag(`rv${target.id}`);
    if (last !== null && w.t - last < prm.stale) continue;
    const seen = view.intel === null ? null : landPop(kit, unitsInReport(kit, view.intel.data));
    const gold = p.spyGold(main, prm.spyMult, seen);
    if (gold === null) return;
    p.spy(main, target.id, gold);
    p.setFlag(`rv${target.id}`, w.t);
    return;
  }
}

/** Drops raid flags that no longer matter, so that the notes stay small. */
function tidy(p: Planner, prm: Opportunist2Params): void {
  const { w } = p;
  for (const [name, v] of Object.entries(p.memory.x)) {
    const age = w.t - v;
    if (/^rvc[1-9]/.test(name) && age >= Math.max(prm.stale, 86400)) p.clearFlag(name);
    if (/^lc[1-9]/.test(name) && age >= prm.cooldown) p.clearFlag(name);
    if (/^(f|pd)[1-9][0-9]*$/.test(name) && age >= FIGHTER_MEMORY) p.clearFlag(name);
  }
}

/**
 * Turns back a betrayal still in its recall window once the seat's own bloc runs a countdown: the
 * betrayal would land during it, and leaving the alliance cancels the countdown.
 */
function holdBetrayal(p: Planner): void {
  const { w } = p;
  if (ownCountdown(w) === null) return;
  for (const m of w.self?.private?.movements ?? []) {
    if (m.owner !== w.seat || m.kind !== "attack" || m.to === null) continue;
    const until = m.recallableUntil;
    if (until === null || until === undefined || until[0] <= w.t) continue;
    const owner = w.others.find((o) => o.id === m.to)?.owner ?? null;
    if (owner === null || w.relations.get(owner) !== "ally") continue;
    p.recall(m.id);
    p.memo(`held back ${m.to} D${w.day + 1}`);
  }
}

export const opportunist2: StrategyDef = Object.freeze<StrategyDef>({
  name: "opportunist",
  version: 2,
  brain(rng) {
    const base = opportunist2Params(rng);
    const knobs = {
      cadence: randInt(rng, 5400, 7200),
      settle: true,
      maxCities: 64,
      producerBase: 4,
      producerPerDay: 2,
      wallBase: 0,
      wallPerDay: 0,
      spendPm: randInt(rng, 650, 800),
      mix: { defender: 1, attacker: 2, navy: 0 },
      carriers: true,
      supportOwn: true,
      escort: randInt(rng, 2, 3),
      militaryFirst: false,
    };
    const prm = raidParams(rng, base);
    const relief = reliefParams(rng);
    return {
      knobs,
      reads(w: World): ToolCall[] {
        const out: ToolCall[] = [call("leaderboard", {})];
        out.push(...reliefReads(w, true), ...countdownReads(w, true));
        if (w.day >= prm.betrayDay - 1) {
          for (const o of friendCities(w).slice(0, FRIEND_SCAN)) {
            out.push(call("view_city", { city: o.id }));
          }
        }
        const main = mainCity(w);
        if (main !== null) {
          for (const o of strangerCities(w, main).slice(0, RAID_SCAN)) {
            out.push(call("view_city", { city: o.id }));
          }
        }
        return out;
      },
      plan(p) {
        const { w } = p;
        const betrayed = p.flag("bt") !== null;
        let allied = w.self?.alliance !== null && w.self?.alliance !== undefined;
        // Pacts unless it betrayed; one alliance from anyone while it has none.
        p.answer((pr) => {
          if (pr.kind === "pact") return !betrayed;
          if (allied) return false;
          allied = true;
          return true;
        });
        remember(p);
        watchFighters(p);
        noteLosses(p);
        holdBetrayal(p);
        relieveSieges(p, relief, true, 0);
        holdSieges(p, relief);
        const keepFounders = stopTheLeader(p, relief, 300, true);
        betray(p, prm);
        scoutFriends(p, prm);
        raid(p, prm);
        court(p, prm);
        courtFighter(p);
        tribute(p, prm);
        p.supportThreatened();
        supportAllies(p, relief);
        if (!keepFounders) p.settle();
        p.founder();
        paceBuilds(p);
        p.economy();
        paceRecruits(p);
        p.units();
        tidy(p, prm);
      },
    };
  },
});
