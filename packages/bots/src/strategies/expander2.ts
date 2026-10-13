// `expander@2` (docs/architecture.md §11.2): expander@1 (`expander.ts`, frozen) plus the relief
// module (`relief.ts`) for its own cities, a reaction to rival domination countdowns, and own-wake
// pacing (`pace.ts`). It stays the peaceful reference player otherwise: its only attacks are a
// relief of its own besieged city and a strike on a bloc whose countdown runs.

import { randInt } from "../rng.ts";
import { paceBuilds, paceRecruits } from "../pace.ts";
import {
  countdownReads,
  holdSieges,
  reliefParams,
  reliefReads,
  relieveSieges,
  stopTheLeader,
} from "../relief.ts";
import type { StrategyDef } from "./strategy.ts";

export const expander2: StrategyDef = Object.freeze<StrategyDef>({
  name: "expander",
  version: 2,
  brain(rng) {
    // The same draws as expander@1, in the same order, then the relief's.
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
      // Its attackers are its relief force: carriers ship them to its cities on other islands.
      carriers: true,
      supportOwn: true,
      escort: randInt(rng, 2, 4),
      militaryFirst: false,
    };
    const prm = reliefParams(rng);
    return {
      knobs,
      reads: (w) => [...reliefReads(w, false), ...countdownReads(w, false)],
      plan(p) {
        // Every pact, and one alliance while it has none (as expander@1).
        let allied = p.w.self?.alliance !== null && p.w.self?.alliance !== undefined;
        p.answer((pr) => {
          if (pr.kind === "pact") return true;
          if (allied) return false;
          allied = true;
          return true;
        });
        relieveSieges(p, prm, false, 0);
        holdSieges(p, prm);
        const keepFounders = stopTheLeader(p, prm, 300, false);
        p.supportThreatened();
        if (!keepFounders) p.settle();
        p.founder();
        paceBuilds(p);
        p.economy();
        paceRecruits(p);
        p.units();
      },
    };
  },
});
