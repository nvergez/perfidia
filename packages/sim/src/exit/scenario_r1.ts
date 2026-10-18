import { getRuleset } from "@perfidia/engine";
import { MemorySink } from "@perfidia/gateway";
import type { Briefing, Json, LogLine, PlayerId } from "@perfidia/protocol";
import { prepareBotRun, runPrepared, type BotRun } from "../harness/index.ts";
import { accept, call, cityOf, scenarioAgents, type Step } from "./scenario.ts";

// The scripted scenario of the `scenario-r1` golden (docs/architecture.md §13.5): six seats of
// `perfidia-1@1.1.0` play domination by conquest (§13.3) through the gateway, with overrides that
// change only numbers (time compression, faster sea paces, armies in the start seed, Olympus held
// by five hoplites and no trireme, and a threshold of N = 6 cities with 2 taken: dominationPm 1,
// dominationMinPerPlayer 1). The map of seed 1 puts the capitals on the ring
// c1 – c4 – c3 – c5 – c2 – c6, neighbours one hour apart at the overridden pace, and Olympus (c7)
// one hour from each.
//
//   t = 0      p1 offers p2 an alliance, which p2 accepts at its next wake. p1 founds a city on its
//              home island and one on its backyard island; p2 founds one on its home island; p4
//              founds one on its home island with most of its peltasts (all four at 3600).
//   t = 600    p1 attacks c4 and, at its next wake, p2 attacks c5, each with a settler: sieges
//              from 4200 and 4800.
//   t = 3600   p4 sends two settlers to its new city.
//   t = 11400  c4 falls to p1: the alliance holds 6 cities, 1 taken. No countdown: 2 are needed.
//   t = 12000  c5 falls to p2 (p5 is eliminated): 7 cities, 2 taken. The countdown starts.
//              p4, which owned c4, attacks it from its new city with a settler: a siege from 15000.
//   t = 19000  p1 attacks Olympus with a settler: a siege from 22600.
//   t = 22200  p4 recaptures c4. It owned it before, so c4 is not taken; the alliance is down to 6
//              cities, 1 taken: the countdown is cancelled (condition).
//   t = 29800  Olympus falls to p1, taken from no owner: 7 cities, 2 taken. A new countdown
//              starts, and the alliance wins when it ends, 4 hours later (44200).

export const SCENARIO_R1_REF = "perfidia-1@1.1.0";
export const SCENARIO_R1_NAME = "scenario-r1";
/** The controller label of every seat: not a registered bot, so the golden is Level E only. */
export const SCENARIO_R1_LABEL = "scenario:r1@1";
export const SCENARIO_R1_SEED = 1;
export const SCENARIO_R1_PLAYERS = 6;

/** Number-only overrides of 1.1.0's defaults (§13.5). */
export const SCENARIO_R1_OVERRIDES: Readonly<Record<string, Json>> = Object.freeze({
  "time.matchEnd": 86400,
  "time.protectionEnd": 0,
  "time.capitalImmunityEnd": 3600,
  "time.siegeDuration": 7200,
  "time.dominationStart": 7200,
  "time.dominationHold": 14400,
  "units.transport.seaPace": 20,
  "movement.homeboundPace": 20,
  "start.capital.units": { hoplite: 10, peltast: 200, settler: 4, transport: 20 },
  "start.olympus.units": { hoplite: 5 },
  "victory.dominationPm": 1,
  "victory.dominationMinPerPlayer": 1,
});

/** The backyard island of a home island (`i(2 + 5s)` → `i(3 + 5s)` with hubs, §2.3 step 5). */
function backyardOf(home: string): string {
  return `i${Number(home.slice(1)) + 1}`;
}

/** A city of the briefing other than `except`, or null. */
function otherCity(b: Briefing, except: string): string | null {
  return b.cities.find((c) => c.id !== except)?.id ?? null;
}

const STEPS: readonly Step[] = [
  {
    seat: "p1",
    at: 0,
    what: "p1 offers p2 an alliance and founds two cities",
    calls: (b) => [
      call("propose_alliance", { to: "p2", kind: "alliance", name: "Delos", text: "Together" }),
      call("found_city", {
        from: "c1",
        island: cityOf(b, "c1").isl,
        units: { settler: 1, peltast: 20 },
      }),
      call("found_city", {
        from: "c1",
        island: backyardOf(cityOf(b, "c1").isl),
        units: { settler: 1, peltast: 20, transport: 2 },
      }),
    ],
  },
  accept("p2", "p1", "alliance"),
  {
    seat: "p2",
    at: 0,
    what: "p2 founds a city",
    calls: (b) => [
      call("found_city", {
        from: "c2",
        island: cityOf(b, "c2").isl,
        units: { settler: 1, peltast: 20 },
      }),
    ],
  },
  {
    seat: "p4",
    at: 0,
    what: "p4 founds c8 with most of its peltasts",
    calls: (b) => [
      call("found_city", {
        from: "c4",
        island: cityOf(b, "c4").isl,
        units: { settler: 1, peltast: 150 },
      }),
    ],
  },
  {
    seat: "p1",
    at: 600,
    what: "p1 attacks c4 with a settler",
    calls: () => [
      call("attack", { from: "c1", to: "c4", units: { peltast: 100, settler: 1, transport: 6 } }),
    ],
  },
  {
    seat: "p2",
    at: 610,
    what: "p2 attacks c5 with a settler",
    calls: () => [
      call("attack", { from: "c2", to: "c5", units: { peltast: 150, settler: 1, transport: 8 } }),
    ],
  },
  {
    seat: "p4",
    at: 3600,
    what: "p4 sends two settlers to its new city",
    calls: (b) => {
      const to = otherCity(b, "c4");
      return to === null ? null : [call("support", { from: "c4", to, units: { settler: 2 } })];
    },
  },
  {
    seat: "p4",
    at: 11400,
    what: "p4 attacks c4, its former capital, from c8 with a settler",
    calls: (b) => {
      if (b.cities.some((c) => c.id === "c4")) return null;
      const from = otherCity(b, "c4");
      return from === null
        ? null
        : [call("attack", { from, to: "c4", units: { peltast: 150, settler: 1 } })];
    },
  },
  {
    seat: "p1",
    at: 19000,
    what: "p1 attacks Olympus with a settler",
    calls: () => [
      call("attack", { from: "c1", to: "c7", units: { peltast: 50, settler: 1, transport: 3 } }),
    ],
  },
];

/** Plays the scenario in lockstep (strict, step invariants) and returns its log. */
export async function runScenarioR1(): Promise<BotRun> {
  const prepared = prepareBotRun({
    ruleset: getRuleset(SCENARIO_R1_REF),
    seed: SCENARIO_R1_SEED,
    players: SCENARIO_R1_PLAYERS,
    overrides: SCENARIO_R1_OVERRIDES,
    clock: { kind: "lockstep" },
    invariants: "step",
    strict: true,
  });
  const seats = prepared.options.setup.seats.map((s): PlayerId => s.id);
  const agents = scenarioAgents(seats, STEPS, SCENARIO_R1_LABEL);
  const sink = new MemorySink();
  const run = await runPrepared({ ...prepared, options: { ...prepared.options, agents } }, sink);
  const lines: LogLine[] = sink.parsed();
  return { run, sink, lines };
}
