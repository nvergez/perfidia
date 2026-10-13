// `turtle@2` (docs/architecture.md §11.2): turtle@1 (`turtle.ts`, frozen) as the supportive ally.
// Economy, wall and defenders, every alliance and pact accepted, never a war of its own; on top:
// - relief (`relief.ts`) of its own and its allies' besieged cities, with its attackers (a small
//   share of its army, 1 for 3 defenders, with carriers) and part of its defenders;
// - defenders sent to an ally's city with an attack on its way, called home once it has passed;
// - a strike on a bloc whose domination countdown runs, when its army can make one;
// - braced cities: on an incoming attack it recruits `max` defenders, cancelling its newest build
//   item for them at most once per city and turn (turtle@1 cancelled the same item again for a
//   second attack on that city, which the engine rejected with `QUEUE_ITEM`), and asks its allies
//   for support;
// - own-wake pacing (`pace.ts`).

import { compareIds } from "@perfidia/protocol";
import { covers } from "../kit.ts";
import { paceBuilds, paceRecruits } from "../pace.ts";
import type { Planner } from "../plan.ts";
import {
  countdownReads,
  holdSieges,
  reliefParams,
  reliefReads,
  relieveSieges,
  stopTheLeader,
  supportAllies,
} from "../relief.ts";
import { randInt } from "../rng.ts";
import type { StrategyDef } from "./strategy.ts";

/** Share (‰) of its defenders at home a city sends on a relief. */
const RELIEF_DEFENDERS_PM = 500;

function brace(p: Planner): void {
  const { w } = p;
  const defender = w.kit.roles.defender;
  const allies = [...w.relations.entries()]
    .filter(([, kind]) => kind === "ally")
    .map(([player]) => player)
    .toSorted(compareIds);
  const braced = new Set<string>();
  for (const inc of w.briefing.incoming) {
    if (inc.kind !== "attack" || inc.arrive[0] <= w.t) continue;
    // A relief of an own besieged city fights the besieger, not the seat: nothing to brace for.
    if (inc.foe !== undefined && inc.foe !== null && inc.foe !== w.seat) continue;
    const c = p.city(inc.to);
    if (c === undefined) continue;
    const recruitKey = `t${inc.id}`;
    if (!p.handled(recruitKey)) {
      if (defender === null || braced.has(c.id)) {
        // One brace per city and turn: its stock went into the first one.
        p.markHandled(recruitKey);
      } else if (p.canRecruit(c, defender)) {
        const cost = w.kit.units.get(defender)?.cost;
        const last = c.build.at(-1);
        if (cost !== undefined && !covers(p.stockOf(c.id), cost) && c.build.length > 1 && last) {
          p.cancel(c, last.item);
        }
        p.recruit(c, [{ unit: defender, count: "max" }]);
        p.markHandled(recruitKey);
        braced.add(c.id);
      }
    }
    const messageKey = `m${inc.id}`;
    if (allies.length > 0 && !p.handled(messageKey)) {
      const text = `Attack on ${inc.to} by ${inc.by}, landing ${inc.arrive[1]}. Please send support to ${inc.to}.`;
      if (p.message(allies, text)) p.markHandled(messageKey);
    }
  }
}

export const turtle2: StrategyDef = Object.freeze<StrategyDef>({
  name: "turtle",
  version: 2,
  brain(rng) {
    // The same draws as turtle@1, in the same order, then the relief's.
    const knobs = {
      cadence: randInt(rng, 7200, 9000),
      settle: true,
      maxCities: randInt(rng, 3, 5),
      producerBase: 4,
      producerPerDay: 2,
      wallBase: 1,
      wallPerDay: 2,
      spendPm: randInt(rng, 600, 750),
      mix: { defender: 3, attacker: 1, navy: 0 },
      carriers: true,
      supportOwn: true,
      escort: randInt(rng, 3, 5),
      militaryFirst: false,
    };
    const prm = reliefParams(rng);
    return {
      knobs,
      reads: (w) => [...reliefReads(w, true), ...countdownReads(w)],
      plan(p) {
        p.answer(() => true);
        brace(p);
        relieveSieges(p, prm, true, RELIEF_DEFENDERS_PM);
        holdSieges(p, prm);
        const keepFounders = stopTheLeader(p, prm, RELIEF_DEFENDERS_PM);
        p.supportThreatened();
        supportAllies(p, prm);
        if (!keepFounders) p.settle();
        p.founder();
        // The wall comes right after the urgent economy wishes, when the ruleset has one.
        const wall = p.w.kit.wall;
        const max = wall === null ? 0 : (p.w.kit.buildings.get(wall)?.maxLevel ?? 0);
        const level = Math.min(max, knobs.wallBase + knobs.wallPerDay * p.w.day);
        paceBuilds(p);
        p.economy(() => (wall === null || level <= 0 ? [] : [{ building: wall, level }]));
        paceRecruits(p);
        p.units();
      },
    };
  },
});
