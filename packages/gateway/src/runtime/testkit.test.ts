// Helpers for the runtime tests: scripted agents, setups for the real rulesets and the testing
// kit's fixture ruleset, and a host on a fresh match that a test drives by hand.

import { expect, test } from "bun:test";
import { createMatch, type AnyRuleset } from "@perfidia/engine";
import { idKeyFromSeed } from "@perfidia/engine/core";
import type { Match } from "@perfidia/engine/kernel";
import { perfidia1_1_0_0 } from "@perfidia/engine/rulesets/perfidia-1";
import { sandbox1_1_0_0 } from "@perfidia/engine/rulesets/sandbox-1";
import { fixtureRuleset } from "@perfidia/engine/testing";
import {
  PlayerIdSchema,
  type Json,
  type LogLine,
  type MatchSetup,
  type PlayerId,
  type RoundInput,
  type RoundOutput,
  type SeatAgent,
  type ToolCall,
  type ToolResult,
} from "@perfidia/protocol";
import { MatchHost, MemorySink, copyOf, type ToolRegistry } from "./index.ts";

export const PERFIDIA: AnyRuleset = perfidia1_1_0_0;
export const SANDBOX: AnyRuleset = sandbox1_1_0_0;
export const FIXTURE: AnyRuleset = fixtureRuleset;

export function seatsOf(n: number): { id: PlayerId }[] {
  return Array.from({ length: n }, (_, i) => ({ id: PlayerIdSchema.parse(`p${i + 1}`) }));
}

export function setupOf(
  ruleset: AnyRuleset,
  players: number,
  overrides: Readonly<Record<string, Json>> = {},
  seed = 11,
): MatchSetup {
  return {
    ruleset: ruleset.ref,
    overrides: { ...overrides },
    seed,
    idKey: idKeyFromSeed(seed),
    seats: seatsOf(players),
  };
}

export const call = (tool: string, args: unknown = {}): ToolCall => ({ tool, args });

/** An agent whose rounds come from `plan`; it keeps a canonical copy of every input it receives. */
export class Scripted implements SeatAgent {
  readonly label: string;
  readonly inputs: RoundInput[] = [];
  private readonly plan: (input: RoundInput, self: Scripted) => RoundOutput;

  constructor(label: string, plan: (input: RoundInput, self: Scripted) => RoundOutput) {
    this.label = label;
    this.plan = plan;
  }

  round(input: RoundInput): Promise<RoundOutput> {
    this.inputs.push(copyOf(input));
    return Promise.resolve(this.plan(input, this));
  }

  /** The inputs of turn `turn`, by round. */
  turn(turn: number): RoundInput[] {
    return this.inputs.filter((i) => i.turn === turn);
  }

  /** The results of the round after round `round` of turn `turn` (what that round's calls returned). */
  results(turn: number, round: number): readonly ToolResult[] {
    const next = this.inputs.find((i) => i.turn === turn && i.round === round + 1);
    if (next === undefined) throw new Error(`no round ${round + 1} in turn ${turn}`);
    return next.results;
  }
}

/** An agent that ends every turn at once with `end_turn {}`. */
export function idle(label = "test:idle"): Scripted {
  return new Scripted(label, () => ({ calls: [call("end_turn")] }));
}

/** A scripted agent that plays `rounds[turn - 1][round]` and ends the turn with `[]` after. */
export function script(
  rounds: readonly (readonly (readonly ToolCall[])[])[],
  label = "test:script",
): Scripted {
  return new Scripted(label, (input) => {
    const calls = rounds[input.turn - 1]?.[input.round];
    return { calls: calls === undefined ? [] : [...calls] };
  });
}

/** Agents for every seat: `given` for some, idle for the others. */
export function agentsFor(
  setup: MatchSetup,
  given: Readonly<Record<string, SeatAgent>>,
): Map<PlayerId, SeatAgent> {
  return new Map(setup.seats.map((s) => [s.id, given[s.id] ?? idle()]));
}

/** A started host on a fresh match of `setup`, driven by hand (no driver). */
export function manualHost(
  ruleset: AnyRuleset,
  setup: MatchSetup,
  o: { readonly strict?: boolean; readonly tools?: ToolRegistry } = {},
): { host: MatchHost; match: Match; sink: MemorySink } {
  const match = createMatch(setup, ruleset, { invariants: "step" });
  const sink = new MemorySink();
  const host = new MatchHost({
    match,
    sink,
    agents: agentsFor(setup, {}),
    clock: { kind: "lockstep", maxTurnsPerSecond: 3 },
    ...(o.strict === undefined ? {} : { strict: o.strict }),
    ...(o.tools === undefined ? {} : { tools: o.tools }),
  });
  host.start();
  return { host, match, sink };
}

/** The lines of `kind`. */
export function linesOf<K extends LogLine["k"]>(
  lines: readonly LogLine[],
  kind: K,
): Extract<LogLine, { k: K }>[] {
  return lines.filter((l): l is Extract<LogLine, { k: K }> => l.k === kind);
}

test("manualHost starts a match: the header, and every seat due at t = 0", () => {
  const { host, sink } = manualHost(SANDBOX, setupOf(SANDBOX, 2));
  const [header] = sink.parsed();
  expect(header).toMatchObject({ k: "header", controllers: { p1: "test:idle", p2: "test:idle" } });
  expect(host.dueSeats(0)).toEqual(["p1", "p2"]);
  expect(host.nextTime()).toBe(0);
});
