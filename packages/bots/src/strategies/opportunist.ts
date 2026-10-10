// `opportunist` (docs/architecture.md §11.2): ally first, betray later. On day 1 it proposes an
// alliance or pacts to its nearest neighbours, sends a small tribute to the strongest player and
// records "ally pX since D1" in its notes. From a seeded day (3 to 5), if it ranks in the top 2
// and an ally's city is weaker than its army, it messages that ally "we remain friends" and attacks
// the city, keeping the relation until the betrayal lands.

import { compareIds, type PlayerId, type ToolCall } from "@perfidia/protocol";
import { call, res } from "../kit.ts";
import { estimateDefense, mainCity, nearby, type Planner } from "../plan.ts";
import { randInt, type BotRng } from "../rng.ts";
import type { OtherCity, OwnCity, World } from "../world.ts";
import type { StrategyDef } from "./strategy.ts";

export interface OpportunistParams {
  /** Game day index (0 = D1) from which it may betray: 2..4, i.e. D3..D5. */
  readonly betrayDay: number;
  /** Attack the ally's city when strength ≥ estimated defense × marginPm / 1000. */
  readonly marginPm: number;
  /** Tribute per resource. */
  readonly tribute: number;
  /** Proposes an alliance (rather than a pact) to its nearest neighbour. */
  readonly allianceFirst: boolean;
  /** Neighbours approached on day 1. */
  readonly neighbours: number;
}

export function opportunistParams(rng: BotRng): OpportunistParams {
  return {
    betrayDay: randInt(rng, 2, 4),
    marginPm: randInt(rng, 1100, 1400),
    tribute: randInt(rng, 50, 150),
    allianceFirst: randInt(rng, 0, 1) === 1,
    neighbours: 3,
  };
}

/** The seat's capital (or its first city). */
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

/** Cities of the seat's allies and pact partners, nearest to its main city first. */
function friendCities(w: World): OtherCity[] {
  const from = mainCity(w);
  if (from === null) return [];
  return nearby(w, from, (o) => o.owner !== null && w.relations.has(o.owner));
}

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

function court(p: Planner, prm: OpportunistParams): void {
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

function tribute(p: Planner, prm: OpportunistParams): void {
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

function betray(p: Planner, prm: OpportunistParams): void {
  const { w } = p;
  if (w.day < prm.betrayDay || p.flag("bt") !== null || w.board === null) return;
  if (w.t < w.kit.rules.time.attackFrom || p.attacksLeft <= 0) return;
  const me = w.board.standings.find((s) => s.player === w.seat);
  if (me === undefined || me.rank > 2) return;
  const main = mainCity(w);
  if (main === null) return;
  for (const target of friendCities(w)) {
    const est = estimateDefense(w, w.views.get(target.id));
    if (est === null || target.owner === null) continue;
    const group = p.attackGroup(main, target.island, 0);
    if (group === null || group.strength * 1000 <= est * prm.marginPm) continue;
    p.message([target.owner], "we remain friends");
    if (p.attack(main, target.id, group.units)) {
      p.setFlag("bt", w.day + 1);
      p.memo(`betray ${target.owner} D${w.day + 1}`);
    }
    return;
  }
}

export const opportunist: StrategyDef = Object.freeze<StrategyDef>({
  name: "opportunist",
  version: 1,
  brain(rng) {
    const prm = opportunistParams(rng);
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
    return {
      knobs,
      reads(w: World): ToolCall[] {
        const out: ToolCall[] = [call("leaderboard", {})];
        if (w.day >= prm.betrayDay) {
          for (const o of friendCities(w).slice(0, 3)) out.push(call("view_city", { city: o.id }));
        }
        return out;
      },
      plan(p) {
        const betrayed = p.flag("bt") !== null;
        p.answer(() => !betrayed);
        remember(p);
        betray(p, prm);
        court(p, prm);
        tribute(p, prm);
        p.supportThreatened();
        p.settle();
        p.founder();
        p.economy();
        p.units();
      },
    };
  },
});
