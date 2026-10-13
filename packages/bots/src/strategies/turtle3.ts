// `turtle@3` (docs/architecture.md §11.2): turtle@2 (`turtle2.ts`, frozen) answering its allies'
// war calls (`war.ts`, `respond.ts`) as the supportive ally it is:
// - a `hold` or `siege` call gets defenders: a seeded share of the defenders of the own cities
//   that land inside the window (for a siege, once the ally's siege has ended and the city is the
//   ally's: only the besieger may support a besieged city), answered yes with the landing, or no
//   with the reason; a strike is declined ("no: i defend, no strikes"). It starts no war and never
//   sends a call;
// - a player that betrayed it is never allied again, nor are its calls answered;
// - an ally's conquest is held: the nearest own city with defenders sends a share of them once the
//   ally owns the city (`holdConquests`), called home 8 h later by `supportAllies`;
// - everything turtle@2 does: braced cities, relief of its own and its allies' besieged cities,
//   support of an ally's threatened city, countdown strikes and own-wake pacing.
//
// Memory: turtle@2's, the war book (`wc` memo lines, `war.ts`) and `gw<city>` (an ally's siege
// whose conquest it will hold).

import { paceBuilds, paceRecruits } from "../pace.ts";
import {
  countdownReads,
  holdSieges,
  reliefParams,
  reliefReads,
  relieveSieges,
  stopTheLeader,
  supportAllies,
} from "../relief.ts";
import {
  answerCalls,
  betrayers,
  closeDesk,
  holdConquests,
  keepWord,
  openDesk,
  rememberBetrayers,
  sendAnswers,
  type ResponderParams,
} from "../respond.ts";
import { randInt } from "../rng.ts";
import { droppedWarOpens, droppedWarSearch } from "../war.ts";
import type { StrategyDef } from "./strategy.ts";
import { brace, RELIEF_DEFENDERS_PM } from "./turtle2.ts";

export const turtle3: StrategyDef = Object.freeze<StrategyDef>({
  name: "turtle",
  version: 3,
  brain(rng) {
    // turtle@2's draws, in the same order, then the war's.
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
    const war: ResponderParams = {
      roles: ["hold", "siege"],
      decline: "i defend, no strikes",
      strikePm: 0,
      minStrike: 0,
      holdPm: prm.sharePm + randInt(rng, 100, 250),
      minHold: randInt(rng, 200, 400),
      aimPm: randInt(rng, 150, 400),
      waves: 2,
    };
    return {
      knobs,
      reads: (w) => [...reliefReads(w, true), ...countdownReads(w, false), ...droppedWarSearch(w)],
      moreReads: droppedWarOpens,
      plan(p) {
        // Every proposal, except a betrayer's.
        rememberBetrayers(p);
        const traitors = betrayers(p);
        p.answer((pr) => !traitors.has(pr.from));
        const desk = openDesk(p);
        brace(p);
        relieveSieges(p, prm, true, RELIEF_DEFENDERS_PM);
        holdSieges(p, prm);
        const keepFounders = stopTheLeader(p, prm, RELIEF_DEFENDERS_PM, false);
        p.supportThreatened();
        answerCalls(p, desk, war);
        keepWord(p, desk, war);
        supportAllies(p, prm);
        holdConquests(p, desk, prm.sharePm);
        sendAnswers(p, desk);
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
        closeDesk(p, desk);
      },
    };
  },
});
