// `expander` (docs/architecture.md §11.2): the peaceful reference bot of perfidia-1 §15.1. It acts
// every 2 h, puts the economy first, recruits a founder as soon as one is affordable and sends it to
// the nearest valuable free slot, spends the surplus on defenders and attackers 1:1, never attacks,
// and supports its own cities under attack. It accepts every pact, and one alliance while it has
// none.

import { randInt } from "../rng.ts";
import type { StrategyDef } from "./strategy.ts";

export const expander: StrategyDef = Object.freeze<StrategyDef>({
  name: "expander",
  version: 1,
  brain(rng) {
    const knobs = {
      cadence: 7200,
      settle: true,
      maxCities: 64,
      producerBase: randInt(rng, 3, 4),
      producerPerDay: 2,
      wallBase: 0,
      wallPerDay: randInt(rng, 0, 1),
      spendPm: randInt(rng, 550, 700),
      mix: { defender: 1, attacker: 1, navy: 0 },
      carriers: false,
      supportOwn: true,
      escort: randInt(rng, 2, 4),
      militaryFirst: false,
    };
    return {
      knobs,
      reads: () => [],
      plan(p) {
        // Every pact, and one alliance while it has none (T17 tuning: only opportunists offer
        // alliances, and an expander that declined them left most matches without one).
        let allied = p.w.self?.alliance !== null && p.w.self?.alliance !== undefined;
        p.answer((pr) => {
          if (pr.kind === "pact") return true;
          if (allied) return false;
          allied = true;
          return true;
        });
        p.supportThreatened();
        p.settle();
        p.founder();
        p.economy();
        p.units();
      },
    };
  },
});
