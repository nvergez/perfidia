import { getRuleset } from "@perfidia/engine";
import { MemorySink } from "@perfidia/gateway";
import type {
  Briefing,
  BriefingCity,
  Json,
  LogLine,
  PlayerId,
  RoundInput,
  RoundOutput,
  SeatAgent,
  ToolCall,
} from "@perfidia/protocol";
import { prepareBotRun, runPrepared, type BotRun } from "../harness/index.ts";

// The scripted scenario of the `scenario-late` golden (docs/architecture.md §13.5): six seats of
// `perfidia-1@1.0.0` play a short script through the gateway, with overrides that change only
// numbers (time compression, faster sea paces, armies in the start seed, low domination thresholds),
// so every code path is the one of the defaults. In about four game hours it covers a siege, a
// relief battle, a homecoming battle, the conquest of a capital whose owner keeps a fallback city
// (its army abroad is re-homed there), an elimination, a pact expiry, a pact superseded by an
// alliance, and a domination countdown started, cancelled and won.
//
// The script is written for seed 1 with six seats, whose map puts the capitals on a ring
// c1 – c4 – c3 – c5 – c2 – c6, neighbours one hour apart at the overridden pace:
//
//   t = 0      p1 offers p2 a pact; p3 offers p5 a pact (it expires at 7800).
//              p4 founds c8 on its home island and stations 150 raiders in c3 (p3's capital);
//              p6 stations its army in c2, leaving its capital nearly empty.
//   t = 600    p2 and p5 accept their pacts. p1 attacks c4 (3 settlers) and c6 (1 settler).
//   t = 1200   p1 offers p2 an alliance; p2 accepts at its next wake: the pact is superseded.
//   t = 4200   p1 besieges c4 (capital immunity ends at 3600) and, ten seconds later, c6.
//              p4 sends a small relief from c8 and recalls a few raiders from c3 into c4: both
//              lose (a relief battle at 7800, a homecoming battle at 7812), and the siege holds.
//   t = 7200   domination opens: no bloc holds 3 of the 8 cities yet.
//   t = 11400  c4 falls to p1; p4 keeps c8, where its raiders in c3 are re-homed. The alliance
//              of p1 and p2 now holds 3 cities: its countdown starts.
//   t = 11410  c6 falls to p1: p6 is eliminated.
//   t = 12000  p2 leaves the alliance: its countdown is cancelled, and p1 alone (c1, c4, c6)
//              starts a new one, which wins at 15600.

export const SCENARIO_LATE_REF = "perfidia-1@1.0.0";
export const SCENARIO_LATE_NAME = "scenario-late";
/** The controller label of every seat: not a registered bot, so the golden is Level E only. */
export const SCENARIO_LATE_LABEL = "scenario:late@1";
export const SCENARIO_LATE_SEED = 1;
export const SCENARIO_LATE_PLAYERS = 6;

/** Number-only overrides of the defaults (§13.5). */
export const SCENARIO_LATE_OVERRIDES: Readonly<Record<string, Json>> = Object.freeze({
  "time.matchEnd": 86400,
  "time.protectionEnd": 0,
  "time.capitalImmunityEnd": 3600,
  "time.siegeDuration": 7200,
  "time.pactDuration": 7200,
  "time.dominationStart": 7200,
  "time.dominationHold": 3600,
  "units.transport.seaPace": 20,
  "movement.homeboundPace": 20,
  "start.capital.units": { guard: 10, raider: 200, settler: 4, transport: 20 },
  "victory.dominationPm": 375,
  "victory.dominationMinPerPlayer": 0,
});

/** A step of the script: one seat's calls at or after `at`, once `calls` is ready (not null). */
interface Step {
  readonly seat: PlayerId;
  readonly at: number;
  readonly what: string;
  calls(b: Briefing): ToolCall[] | null;
}

const call = (tool: string, args: Record<string, Json>): ToolCall => ({ tool, args });

function cityOf(b: Briefing, id: string): BriefingCity {
  const c = b.cities.find((x) => x.id === id);
  if (c === undefined) throw new Error(`scenario: ${b.you} does not own ${id} at t = ${b.t}`);
  return c;
}

/** Accepts the open proposal of `kind` from `from` once the briefing lists it. */
function accept(seat: PlayerId, from: PlayerId, kind: "pact" | "alliance"): Step {
  return {
    seat,
    at: 0,
    what: `${seat} accepts the ${kind} of ${from}`,
    calls: (b) => {
      const p = b.proposals.find((x) => x.from === from && x.to === seat && x.kind === kind);
      return p === undefined ? null : [call("answer_proposal", { id: p.id, accept: true })];
    },
  };
}

const STEPS: readonly Step[] = [
  {
    seat: "p1",
    at: 0,
    what: "p1 offers p2 a pact",
    calls: () => [call("propose_alliance", { to: "p2", kind: "pact", text: "Peace between us?" })],
  },
  {
    seat: "p3",
    at: 0,
    what: "p3 offers p5 a pact",
    calls: () => [call("propose_alliance", { to: "p5", kind: "pact", text: "Two hours of peace" })],
  },
  {
    seat: "p4",
    at: 0,
    what: "p4 founds a second city and stations an army in c3",
    calls: (b) => [
      call("found_city", {
        from: "c4",
        island: cityOf(b, "c4").isl,
        units: { settler: 1, raider: 20 },
      }),
      call("support", { from: "c4", to: "c3", units: { raider: 150, transport: 8 } }),
    ],
  },
  {
    seat: "p6",
    at: 0,
    what: "p6 stations its army in c2",
    calls: () => [call("support", { from: "c6", to: "c2", units: { raider: 200, transport: 10 } })],
  },
  accept("p2", "p1", "pact"),
  accept("p5", "p3", "pact"),
  {
    seat: "p1",
    at: 600,
    what: "p1 attacks c4 and c6 with settlers",
    calls: () => [
      call("attack", { from: "c1", to: "c4", units: { raider: 100, settler: 3, transport: 7 } }),
      call("attack", { from: "c1", to: "c6", units: { raider: 80, settler: 1, transport: 5 } }),
    ],
  },
  {
    seat: "p1",
    at: 1200,
    what: "p1 offers p2 an alliance",
    calls: () => [
      call("propose_alliance", { to: "p2", kind: "alliance", name: "Tide", text: "Join me" }),
    ],
  },
  accept("p2", "p1", "alliance"),
  {
    seat: "p4",
    at: 4200,
    what: "p4 relieves c4 from its new city and recalls raiders into besieged c4",
    calls: (b) => {
      if (cityOf(b, "c4").ext?.["siege"] === undefined) return null;
      const other = b.cities.find((c) => c.id !== "c4");
      if (other === undefined) throw new Error("scenario: p4 has no second city");
      return [
        call("attack", { from: other.id, to: "c4", units: { raider: 5 } }),
        call("recall_troops", { stationedAt: "c3", home: "c4", units: { raider: 5 } }),
      ];
    },
  },
  {
    seat: "p2",
    at: 12000,
    what: "p2 leaves the alliance",
    calls: () => [call("leave_alliance", {})],
  },
];

/**
 * A seat of the scenario. In round 0 of a turn it sends the calls of its steps that are due and
 * ready; in round 1 it checks that every call was accepted (a rejected call is a broken script and
 * throws, which is fatal in strict mode) and ends its turn with a self-wake at its next timed step.
 */
export class ScenarioAgent implements SeatAgent {
  readonly label = SCENARIO_LATE_LABEL;
  readonly #steps: readonly Step[];
  readonly #done = new Set<Step>();
  #sent: { what: string; calls: number }[] = [];

  constructor(seat: PlayerId, steps: readonly Step[] = STEPS) {
    this.#steps = steps.filter((s) => s.seat === seat);
  }

  round(input: RoundInput): Promise<RoundOutput> {
    const b = input.briefing;
    if (input.round === 0) {
      const calls: ToolCall[] = [];
      this.#sent = [];
      for (const step of this.#steps) {
        if (this.#done.has(step) || step.at > b.t) continue;
        const more = step.calls(b);
        if (more === null) continue;
        if (calls.length + more.length >= input.maxCalls) break;
        this.#done.add(step);
        calls.push(...more);
        this.#sent.push({ what: step.what, calls: more.length });
      }
      if (calls.length > 0) {
        return Promise.resolve({ calls, thought: this.#sent.map((s) => s.what).join("; ") });
      }
    } else {
      let i = 0;
      for (const s of this.#sent) {
        for (const r of input.results.slice(i, i + s.calls)) {
          if (!r.ok) {
            throw new Error(
              `scenario step "${s.what}" failed at t = ${b.t}: ${r.code} ${r.message}`,
            );
          }
        }
        i += s.calls;
      }
      this.#sent = [];
    }
    return Promise.resolve({ calls: [this.#endTurn(b.t)] });
  }

  /** `end_turn` with a self-wake at the next timed step (the gateway clamps it into its range). */
  #endTurn(t: number): ToolCall {
    const next = this.#steps
      .filter((s) => !this.#done.has(s) && s.at > t)
      .reduce<number | null>((min, s) => (min === null || s.at < min ? s.at : min), null);
    return call("end_turn", next === null ? {} : { wakeAt: next });
  }
}

/** One scenario agent per seat. */
export function scenarioAgents(seats: readonly PlayerId[]): Map<PlayerId, SeatAgent> {
  return new Map(seats.map((seat): [PlayerId, SeatAgent] => [seat, new ScenarioAgent(seat)]));
}

/** Plays the scenario in lockstep (strict, step invariants) and returns its log. */
export async function runScenarioLate(): Promise<BotRun> {
  const prepared = prepareBotRun({
    ruleset: getRuleset(SCENARIO_LATE_REF),
    seed: SCENARIO_LATE_SEED,
    players: SCENARIO_LATE_PLAYERS,
    overrides: SCENARIO_LATE_OVERRIDES,
    clock: { kind: "lockstep" },
    invariants: "step",
    strict: true,
  });
  const agents = scenarioAgents(prepared.options.setup.seats.map((s) => s.id));
  const sink = new MemorySink();
  const run = await runPrepared({ ...prepared, options: { ...prepared.options, agents } }, sink);
  const lines: LogLine[] = sink.parsed();
  return { run, sink, lines };
}
