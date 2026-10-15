// Helpers for the orchestrator tests: a briefing, round inputs and results, a virtual clock, and an
// LLM seat wired to a scripted `FakeAdapter`, an in-memory call log and a ledger.

import { expect, test } from "bun:test";
import { canonicalJson } from "@perfidia/engine/core";
import { VirtualTime } from "@perfidia/gateway/clock";
import type { Briefing, PlayerId, RoundInput, SeatAgent, ToolResult } from "@perfidia/protocol";
import { BudgetLedger, type HandoffNote } from "./budget/ledger.ts";
import { MemoryCallLog } from "./log/calls.ts";
import type { ModelSpec, ModelTool } from "./model/adapter.ts";
import { seededRandom, type HarnessClock } from "./model/clock.ts";
import { FakeAdapter, scripted, type Brain, type FakeStep } from "./model/fake.ts";
import { RateGate } from "./model/rate.ts";
import { LOCKSTEP_POLICY, LlmSeatAgent, type SeatPolicy } from "./seat/agent.ts";
import { NoPauseGate, type PauseGate } from "./seat/pause.ts";
import { PROFILES } from "./seat/personalities.ts";
import { anthropicTools } from "./model/tools.ts";

export const SPEC: ModelSpec = {
  provider: "fake",
  model: "claude-opus-5-5",
  effort: "medium",
  maxOutputTokens: 16_000,
  cacheTtl: "5m",
};

export const TOOLS: readonly ModelTool[] = anthropicTools([
  {
    name: "view_map",
    description: "The map.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "end_turn",
    description: "Ends the turn.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
]);

export const PROMPT = { shared: "SHARED", seat: "SEAT p1" };

export function briefingOf(t = 0, extra: Partial<Briefing> = {}): Briefing {
  return {
    you: "p1",
    t,
    time: t === 0 ? "D1 00:00" : `t=${t}`,
    left: [604800 - t, "7d"],
    ruleset: "perfidia-1@1.1.0",
    wake: { urgent: false, reasons: ["start"] },
    lastTurn: null,
    cities: [],
    incoming: [],
    moves: [],
    msgs: [],
    proposals: [],
    events: [],
    news: [],
    notes: "",
    budget: {
      roundTrips: 8,
      callsPerRoundTrip: 10,
      ownWakesLeft: 12,
      socialWakesLeft: 8,
      selfWakeAt: null,
      attacksLeft: 20,
      messagesLeft: 20,
    },
    ext: {},
    ...extra,
  };
}

export const ok = (t = 0, data: Record<string, string | number> = {}): ToolResult => ({
  ok: true,
  t,
  data,
});

export const rejected = (t = 0): ToolResult => ({
  ok: false,
  t,
  code: "INVALID_ARGS",
  message: "bad",
  hint: "fix it",
});

export function inputOf(
  turn: number,
  round: number,
  results: readonly ToolResult[] = [],
  o: { readonly maxRounds?: number; readonly maxCalls?: number; readonly briefing?: Briefing } = {},
): RoundInput {
  return {
    seat: "p1",
    turn,
    round,
    maxRounds: o.maxRounds ?? 8,
    maxCalls: o.maxCalls ?? 10,
    briefing: o.briefing ?? briefingOf(),
    results,
  };
}

export const virtualTime = (): VirtualTime =>
  new VirtualTime({ yieldMacrotask: () => new Promise((r) => setImmediate(r)) });

export interface SeatRig {
  readonly agent: LlmSeatAgent;
  readonly fake: FakeAdapter;
  readonly log: MemoryCallLog;
  readonly ledger: BudgetLedger;
  readonly time: VirtualTime;
  readonly clock: HarnessClock;
  readonly rate: RateGate;
  readonly handoffs: HandoffNote[];
}

export interface RigOptions {
  readonly seat?: PlayerId;
  readonly capNanoUsd?: number;
  readonly wakeCapNanoUsd?: number | null;
  readonly policy?: Partial<SeatPolicy>;
  readonly gate?: PauseGate;
  readonly time?: VirtualTime;
  readonly clock?: HarnessClock;
  readonly spec?: ModelSpec;
}

const idleBot = (label: string): SeatAgent => ({
  label,
  round: () => Promise.resolve({ calls: [] }),
});

/** An LLM seat on a fake model whose replies come from `brain` (or the steps of a script). */
export function rig(brain: Brain | readonly FakeStep[], o: RigOptions = {}): SeatRig {
  const seat = o.seat ?? "p1";
  const time = o.time ?? virtualTime();
  const clock = o.clock ?? { time, random: seededRandom(1) };
  const fake = new FakeAdapter(
    o.spec ?? SPEC,
    typeof brain === "function" ? brain : scripted(brain),
  );
  const log = new MemoryCallLog();
  const handoffs: HandoffNote[] = [];
  const ledger = new BudgetLedger({
    caps: new Map([[seat, o.capNanoUsd ?? 100_000_000_000]]),
    wakeCapNanoUsd: o.wakeCapNanoUsd ?? 2_000_000_000,
    handoffTo: () => ({ label: "bot:turtle@3", agent: idleBot("bot:turtle@3") }),
    onHandoff: (n) => handoffs.push(n),
  });
  const rate = new RateGate({ clock, maxInflight: 4 });
  const profile = PROFILES[0];
  if (profile === undefined) throw new Error("no profile");
  const agent = new LlmSeatAgent({
    seat,
    adapter: fake,
    prompt: PROMPT,
    tools: TOOLS,
    profile,
    ledger,
    log,
    clock,
    gate: o.gate ?? new NoPauseGate(),
    rate,
    policy: { ...LOCKSTEP_POLICY, ...o.policy },
  });
  return { agent, fake, log, ledger, time, clock, rate, handoffs };
}

/** The `llm_call` lines of a log. */
export function calls(log: MemoryCallLog) {
  return log.lines.flatMap((l) => (l.k === "llm_call" ? [l] : []));
}

/** The rejection of a promise (fails when it resolves). */
export async function rejection(p: Promise<unknown>): Promise<Error> {
  const out = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(out instanceof Error)) throw new Error(`expected a rejection, got ${String(out)}`);
  return out;
}

test("the testkit briefing is canonical JSON", () => {
  expect(JSON.parse(canonicalJson(briefingOf()))).toEqual(briefingOf());
});
