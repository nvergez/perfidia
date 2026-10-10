// `turtle` (docs/architecture.md §11.2): economy, wall (when the ruleset has one) and defenders;
// accepts every alliance and pact; never attacks. On an incoming attack it recruits `max` defenders
// in the threatened city (cancelling its newest queued build item when not even one defender is
// affordable) and asks its allies (alliance members, not pact partners) for support by message.
// Each part is remembered once done (`t<id>` for the recruit, `m<id>` for the message), so a part
// that could not be done (the city was not read, its queue was full, no message left, no ally yet)
// is tried again on the next wake before the attack lands.

import { compareIds } from "@perfidia/protocol";
import { covers } from "../kit.ts";
import type { Planner } from "../plan.ts";
import { randInt } from "../rng.ts";
import type { StrategyDef } from "./strategy.ts";

function brace(p: Planner): void {
  const { w } = p;
  const defender = w.kit.roles.defender;
  const allies = [...w.relations.entries()]
    .filter(([, kind]) => kind === "ally")
    .map(([player]) => player)
    .toSorted(compareIds);
  for (const inc of w.briefing.incoming) {
    if (inc.kind !== "attack" || inc.arrive[0] <= w.t) continue;
    // A relief of an own besieged city fights the besieger, not the seat: nothing to brace for.
    if (inc.foe !== undefined && inc.foe !== null && inc.foe !== w.seat) continue;
    const c = p.city(inc.to);
    if (c === undefined) continue;
    const recruitKey = `t${inc.id}`;
    if (!p.handled(recruitKey)) {
      if (defender === null) {
        p.markHandled(recruitKey);
      } else if (p.canRecruit(c, defender)) {
        const cost = w.kit.units.get(defender)?.cost;
        const last = c.build.at(-1);
        if (cost !== undefined && !covers(p.stockOf(c.id), cost) && c.build.length > 1 && last) {
          p.cancel(c, last.item);
        }
        p.recruit(c, [{ unit: defender, count: "max" }]);
        p.markHandled(recruitKey);
      }
    }
    const messageKey = `m${inc.id}`;
    if (allies.length > 0 && !p.handled(messageKey)) {
      const text = `Attack on ${inc.to} by ${inc.by}, landing ${inc.arrive[1]}. Please send support to ${inc.to}.`;
      if (p.message(allies, text)) p.markHandled(messageKey);
    }
  }
}

export const turtle: StrategyDef = Object.freeze<StrategyDef>({
  name: "turtle",
  version: 1,
  brain(rng) {
    const knobs = {
      cadence: randInt(rng, 7200, 9000),
      settle: true,
      maxCities: randInt(rng, 3, 5),
      producerBase: 4,
      producerPerDay: 2,
      wallBase: 1,
      wallPerDay: 2,
      spendPm: randInt(rng, 600, 750),
      mix: { defender: 1, attacker: 0, navy: 0 },
      carriers: false,
      supportOwn: true,
      escort: randInt(rng, 3, 5),
      militaryFirst: false,
    };
    return {
      knobs,
      reads: () => [],
      plan(p) {
        p.answer(() => true);
        brace(p);
        p.supportThreatened();
        p.settle();
        p.founder();
        // The wall comes right after the urgent economy wishes, when the ruleset has one.
        const wall = p.w.kit.wall;
        const max = wall === null ? 0 : (p.w.kit.buildings.get(wall)?.maxLevel ?? 0);
        const level = Math.min(max, knobs.wallBase + knobs.wallPerDay * p.w.day);
        p.economy(() => (wall === null || level <= 0 ? [] : [{ building: wall, level }]));
        p.units();
      },
    };
  },
});
