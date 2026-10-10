// `rusher` (docs/architecture.md §11.2): early attack-unit building, attackers and carriers; spies the
// nearest non-allied cities; raids when its attack exceeds the estimated defense by a seeded margin
// (at least 1.5×); brings 2 founders against weak colonies (a conquest attempt); recalls an attack
// within the window when a fresher report shows a stronger defense.

import type { ToolCall } from "@perfidia/protocol";
import { call, countOf, covers, landPop, power, unitsInReport } from "../kit.ts";
import {
  estimateDefense,
  intelAge,
  mainCity,
  nearby,
  unlockWishes,
  type Planner,
} from "../plan.ts";
import { randInt, type BotRng } from "../rng.ts";
import type { OtherCity, OwnCity, World } from "../world.ts";
import type { StrategyDef } from "./strategy.ts";

/** Other players' cities whose owner has no relation with the seat, nearest first. */
function strangers(w: World, from: OwnCity): OtherCity[] {
  return nearby(w, from, (o) => o.owner !== null && !w.relations.has(o.owner));
}

export interface RusherParams {
  /** Attack only when strength ≥ estimated defense × marginPm / 1000. */
  readonly marginPm: number;
  /** Fewest attackers worth a launch. */
  readonly minAttackers: number;
  /** Spy gold = spyMinGold × spyMult + the land pop last seen in the city. */
  readonly spyMult: number;
  /** Intel older than this is refreshed by a spy before attacking. */
  readonly stale: number;
  /** Targets looked at per turn. */
  readonly scan: number;
}

export function rusherParams(rng: BotRng): RusherParams {
  return {
    marginPm: randInt(rng, 1500, 2000),
    minAttackers: randInt(rng, 8, 14),
    spyMult: randInt(rng, 2, 4),
    stale: randInt(rng, 14400, 28800),
    scan: 3,
  };
}

function recallWeakened(p: Planner, prm: RusherParams): void {
  const { w } = p;
  const kinds: readonly string[] = w.kit.rules.movement.recall.kinds;
  if (!kinds.includes("attack")) return;
  for (const m of w.self?.private?.movements ?? []) {
    if (m.kind !== "attack" || m.owner !== w.seat || m.to === null || m.units === undefined)
      continue;
    const until = m.recallableUntil ?? null;
    if (until === null || until[0] < w.t) continue;
    const view = w.views.get(m.to);
    if (view === undefined || view.access !== "public" || view.intel === null) continue;
    if (view.intel.at[0] <= m.depart[0]) continue;
    const est = estimateDefense(w, view);
    if (est === null) continue;
    const strength = power(w.kit, m.units, "attack", true);
    if (strength * 1000 < est * prm.marginPm) p.recall(m.id);
  }
}

function offense(p: Planner, prm: RusherParams): void {
  const { w } = p;
  const kit = w.kit;
  const main = mainCity(w);
  if (main === null) return;
  const attacker = kit.roles.attacker;
  // Spying pays only when an attack can follow: enough attackers at home, protection nearly over.
  const ready =
    countOf(main.units, attacker) * 2 >= prm.minAttackers &&
    w.t + 2 * 3600 >= kit.rules.time.attackFrom;
  let spied = false;
  for (const target of strangers(w, main).slice(0, prm.scan)) {
    const view = w.views.get(target.id);
    if (view !== undefined && view.tag !== null && w.hints.avoidTags.includes(view.tag)) continue;
    const est = estimateDefense(w, view);
    const age = intelAge(w, view);
    if (est === null || age === null || age > prm.stale) {
      const flag = `s${target.id}`;
      const last = p.flag(flag);
      if (!ready || spied || p.inFlight("spy", target.id)) continue;
      if (last !== null && w.t - last < prm.stale) continue;
      const seen = view?.access === "public" && view.intel !== null ? view.intel.data : null;
      const gold = p.spyGold(
        main,
        prm.spyMult,
        seen === null ? null : landPop(kit, unitsInReport(kit, seen)),
      );
      if (gold !== null) {
        p.spy(main, target.id, gold);
        p.setFlag(flag, w.t);
        spied = true;
      }
      continue;
    }
    if (w.t < kit.rules.time.attackFrom || p.attacksLeft <= 0) continue;
    const raid = p.attackGroup(main, target.island, 0);
    if (raid === null) continue;
    // A colony this weak is worth a conquest attempt: two founders ride along when they fit.
    const weakColony = target.capitalOf === null && raid.strength * 1000 >= est * prm.marginPm * 2;
    const group = weakColony ? (p.attackGroup(main, target.island, 2) ?? raid) : raid;
    if (countOf(group.units, attacker) < prm.minAttackers) continue;
    if (group.strength * 1000 >= est * prm.marginPm) {
      p.attack(main, target.id, group.units);
      return;
    }
  }
}

/** Keeps two founders ready in the main city for conquest attempts once the economy allows. */
function conquestFounders(p: Planner): void {
  const { w } = p;
  const kit = w.kit;
  const main = mainCity(w);
  const founder = kit.roles.founder;
  if (main === null || w.day < 1 || !p.canRecruit(main, founder)) return;
  if (countOf(p.homeOf(main.id), founder) + p.queued(main, founder) >= 2) return;
  const cost = w.self?.private?.settler.cost;
  if (cost !== undefined && covers(p.stockOf(main.id), cost)) {
    p.recruit(main, [{ unit: founder, count: 1 }], cost);
  }
}

export const rusher: StrategyDef = Object.freeze<StrategyDef>({
  name: "rusher",
  version: 1,
  brain(rng) {
    const prm = rusherParams(rng);
    const knobs = {
      cadence: randInt(rng, 3600, 5400),
      settle: true,
      maxCities: randInt(rng, 2, 3),
      producerBase: 3,
      producerPerDay: 2,
      wallBase: 0,
      wallPerDay: 0,
      spendPm: randInt(rng, 800, 900),
      mix: { defender: 1, attacker: randInt(rng, 3, 4), navy: 0 },
      carriers: true,
      supportOwn: false,
      escort: 0,
      militaryFirst: true,
    };
    return {
      knobs,
      reads(w: World): ToolCall[] {
        const out: ToolCall[] = [];
        for (const m of w.self?.private?.movements ?? []) {
          const until = m.recallableUntil ?? null;
          if (m.kind === "attack" && m.to !== null && until !== null && until[0] >= w.t) {
            out.push(call("view_city", { city: m.to }));
          }
        }
        const main = mainCity(w);
        if (main !== null) {
          for (const o of strangers(w, main).slice(0, prm.scan)) {
            out.push(call("view_city", { city: o.id }));
          }
        }
        return out;
      },
      plan(p) {
        p.answer(() => false);
        recallWeakened(p, prm);
        offense(p, prm);
        p.settle();
        p.founder();
        conquestFounders(p);
        p.economy(() => (p.w.day >= 1 ? unlockWishes(p.w.kit, p.w.kit.roles.founder) : []));
        p.units();
      },
    };
  },
});
