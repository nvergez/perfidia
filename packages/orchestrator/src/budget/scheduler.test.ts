// The match budget's guarantee under every interleaving (phase-4 design §5.2, §8 item 6): four real
// LLM seat agents (`LlmSeatAgent`, the code that checks the kill flag before each attempt) on fake
// models whose replies a fast-check scheduler resolves in a random order, with random usages up to
// each attempt's limits (prompt ≤ the prompt cap, output ≤ the request's max_tokens), retried
// errors charged like broken streams (the full max_tokens), `max_tokens` stops and their larger
// retry, thought calls, pause-gate probes charged while attempts are in flight, a start preflight,
// a carry, and a kill threshold anywhere from 0 to a few attempts' worth. Always:
// - the total charged never exceeds the budget;
// - no model attempt (round, retry or thought call) starts once the kill switch has fired, not
//   even one that was waiting for its model's rate-gate slot when it fired, and no probe either;
// - once it fired, every seat not already handed off for its own cap is handed off `match_budget`;
// - every charge stays within its attempt bound (the premise of the guarantee).

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { PlayerId, RoundInput, SeatAgent, Sleep, TimeSource } from "@perfidia/protocol";
import { MemoryCallLog } from "../log/calls.ts";
import { ModelError, type ChatRequest, type ModelSpec, type UsageEntry } from "../model/adapter.ts";
import { FakeAdapter, type FakeReply } from "../model/fake.ts";
import { costOf } from "../model/prices.ts";
import { RateGates } from "../model/rate.ts";
import { AgentError, LOCKSTEP_POLICY, LlmSeatAgent } from "../seat/agent.ts";
import { NoPauseGate } from "../seat/pause.ts";
import { PROFILES } from "../seat/personalities.ts";
import { groupCheckBound, seatAttemptBound } from "../arena/estimate.ts";
import { PROMPT, TOOLS, briefingOf, ok } from "../testkit.test.ts";
import { BudgetLedger, MatchBudget, type HandoffNote } from "./ledger.ts";

/** Wall time that never moves: a sleep to now or earlier resolves, a later one never does. */
class FrozenTime implements TimeSource {
  nowMs(): number {
    return 0;
  }

  sleepUntil(ms: number): Sleep {
    const done = ms <= 0 ? Promise.resolve() : new Promise<void>(() => undefined);
    return { done, cancel: () => undefined };
  }
}

const PROMPT_CAP = 160_000;
const MAX_TOKENS = 16_000;
const SEATS: readonly { seat: PlayerId; model: string }[] = [
  { seat: "p1", model: "claude-sonnet-5-5" },
  { seat: "p2", model: "claude-haiku-5-5" },
  { seat: "p3", model: "claude-haiku-5-5" },
  { seat: "p4", model: "claude-haiku-5-5" },
];
const idle = (label: string): SeatAgent => ({ label, round: () => Promise.resolve({ calls: [] }) });

/** What one model attempt does. */
interface Outcome {
  readonly kind: "reply" | "max_tokens" | "error";
  /** Calls of a reply (0: the turn ends). */
  readonly calls: number;
  /** Shares of the prompt, in per mille of the prompt cap. */
  readonly promptPermille: number;
  readonly split: readonly [number, number, number, number];
  readonly outputPermille: number;
}

const outcome: fc.Arbitrary<Outcome> = fc.record({
  kind: fc.constantFrom("reply", "reply", "reply", "max_tokens", "error"),
  calls: fc.integer({ min: 0, max: 2 }),
  promptPermille: fc.integer({ min: 0, max: 1000 }),
  split: fc.tuple(
    fc.integer({ min: 0, max: 100 }),
    fc.integer({ min: 0, max: 100 }),
    fc.integer({ min: 0, max: 100 }),
    fc.integer({ min: 0, max: 100 }),
  ),
  outputPermille: fc.integer({ min: 0, max: 1000 }),
});

/** A usage within the attempt's limits: prompt ≤ the cap (any split), output ≤ `maxTokens`. */
function usageOf(model: string, o: Outcome, maxTokens: number, estimated: boolean): UsageEntry {
  const prompt = Math.floor((PROMPT_CAP * o.promptPermille) / 1000);
  const [a, b, c, d] = o.split;
  const sum = a + b + c + d || 1;
  const input = Math.floor((prompt * a) / sum);
  const w5 = Math.floor((prompt * b) / sum);
  const w1 = Math.floor((prompt * c) / sum);
  const read = prompt - input - w5 - w1;
  return {
    model,
    kind: "message",
    tokens: {
      input,
      cacheWrite5m: w5,
      cacheWrite1h: w1,
      cacheRead: read,
      output: estimated ? maxTokens : Math.floor((maxTokens * o.outputPermille) / 1000),
    },
    estimated,
  };
}

/** What the runs covered (checked once the property has run). */
const seen = { runs: 0, killed: 0, killedMidFlight: 0, attempts: 0, probes: 0, inFlightAtKill: 0 };

interface Pending {
  readonly what: string;
  readonly resolve: () => void;
}

interface Scenario {
  /** Concurrent requests per model: 1 makes seats queue at the rate gate. */
  readonly maxInflight: number;
  readonly killPermille: number;
  readonly carryPermille: number;
  readonly turns: number;
  readonly outcomes: readonly Outcome[];
  readonly probeCosts: readonly number[];
  readonly choices: readonly number[];
}

/** A few macrotask turns: every seat reaches its next attempt (or its next await). */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    // oxlint-disable-next-line no-await-in-loop -- let every seat reach its next attempt
    await new Promise((r) => setImmediate(r));
  }
}

async function play(s: Scenario): Promise<void> {
  const bounds = new Map(
    SEATS.map((x) => [x.seat, seatAttemptBound(x.model, "off", MAX_TOKENS, PROMPT_CAP)]),
  );
  const sample = 40_000;
  const probeBound =
    groupCheckBound("claude-sonnet-5-5", "off", sample) +
    groupCheckBound("claude-haiku-5-5", "off", sample);
  const reserve = [...bounds.values()].reduce((a, b) => a + b, 0) + 2 * probeBound;
  // K anywhere from 0 to about twelve Sonnet attempt bounds.
  const killAt = Math.floor(((bounds.get("p1") ?? 0) * 12 * s.killPermille) / 1000);
  const carry = Math.floor((killAt * s.carryPermille) / 1000);
  let inFlight = 0;
  const budget = new MatchBudget({
    budgetNanoUsd: killAt + reserve,
    reserveNanoUsd: reserve,
    carryNanoUsd: carry,
    onKill: () => {
      // The pending replies at this moment, the one being charged excluded.
      seen.inFlightAtKill = Math.max(seen.inFlightAtKill, inFlight);
      if (inFlight > 0) seen.killedMidFlight += 1;
    },
  });
  const handoffs: HandoffNote[] = [];
  const ledger = new BudgetLedger({
    caps: new Map(SEATS.map((x) => [x.seat, 10 ** 12])),
    wakeCapNanoUsd: null,
    handoffTo: (seat) => ({ label: "bot:turtle@3", agent: idle(`bot:turtle@3 ${seat}`) }),
    onHandoff: (n) => handoffs.push(n),
    match: budget,
  });
  // The start preflight, charged before the match like the arena's.
  budget.add(Math.floor(probeBound / 2), 0);

  const pending: Pending[] = [];
  const violations: string[] = [];
  let next = 0;
  const outcomeOf = (): Outcome => {
    const o = s.outcomes[next % s.outcomes.length] ?? s.outcomes[0];
    next += 1;
    if (o === undefined) throw new Error("no outcome");
    return o;
  };
  const time = new FrozenTime();
  const clock = { time, random: () => 0 };
  const rates = new RateGates({ clock, maxInflight: s.maxInflight, releaseJitterMs: 0 });
  const gate = new NoPauseGate();
  const log = new MemoryCallLog({ transcripts: false });
  const charged: { seat: PlayerId; cost: number }[] = [];
  const agents = SEATS.map(({ seat, model }) => {
    const spec: ModelSpec = {
      provider: "fake",
      model,
      effort: "medium",
      maxOutputTokens: MAX_TOKENS,
      cacheTtl: "5m",
      fallbacks: "off",
    };
    const brain = (req: ChatRequest): Promise<FakeReply | ModelError> => {
      if (budget.killed) violations.push(`${seat}: an attempt started after the kill switch`);
      seen.attempts += 1;
      const o = outcomeOf();
      const maxTokens = req.maxOutputTokens ?? MAX_TOKENS;
      return new Promise((resolve) => {
        pending.push({
          what: `${seat} ${req.meta.kind} turn ${req.meta.turn} round ${req.meta.round}`,
          resolve: () => {
            if (o.kind === "error") {
              const spent = [usageOf(model, o, maxTokens, true)];
              charged.push({ seat, cost: costOf(spent).nanoUsd });
              resolve(new ModelError("overloaded", "SSE overloaded", { spent, retryAfterMs: 0 }));
              return;
            }
            const usage = [usageOf(model, o, maxTokens, false)];
            charged.push({ seat, cost: costOf(usage).nanoUsd });
            resolve({
              usage,
              ...(o.kind === "max_tokens" ? { stop: "max_tokens" as const } : {}),
              calls:
                req.meta.kind === "thought"
                  ? []
                  : Array.from({ length: o.calls }, () => ({ name: "view_map", args: {} })),
            });
          },
        });
      });
    };
    const profile = PROFILES[0];
    if (profile === undefined) throw new Error("no profile");
    const agent = new LlmSeatAgent({
      seat,
      adapter: new FakeAdapter(spec, brain),
      prompt: PROMPT,
      tools: TOOLS,
      profile,
      ledger,
      log,
      clock,
      gate,
      rate: rates.gate("fake", model),
      policy: {
        ...LOCKSTEP_POLICY,
        thoughtCall: true,
        promptCapTokens: PROMPT_CAP,
        backoff: { baseMs: 0, capMs: 0, retryAfterJitterMs: 0 },
      },
    });
    return { seat, agent };
  });

  // Each seat plays its turns one after the other; a turn goes on while the reply makes calls.
  let done = 0;
  const loops = agents.map(async ({ seat, agent }) => {
    for (let turn = 1; turn <= s.turns; turn += 1) {
      let results: RoundInput["results"] = [];
      for (let round = 0; round < 3; round += 1) {
        const input: RoundInput = {
          seat,
          turn,
          round,
          maxRounds: 3,
          maxCalls: 10,
          briefing: { ...briefingOf(turn * 3600), you: seat },
          results,
        };
        try {
          // oxlint-disable-next-line no-await-in-loop -- a seat's rounds are sequential
          const out = await agent.round(input);
          if (out.calls.length === 0) break;
          results = out.calls.map(() => ok(turn * 3600));
        } catch (e) {
          if (!(e instanceof AgentError)) throw e;
          break;
        }
      }
    }
    done += 1;
  });

  // The scheduler: settle, then resolve one pending reply or start/finish a probe, as chosen.
  let probe: { cost: number } | null = null;
  let probeNo = 0;
  for (let step = 0; step < 10_000; step += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one scheduling decision at a time
    await settle();
    if (done === agents.length && pending.length === 0 && probe === null) break;
    const choice = s.choices[step % s.choices.length] ?? 0;
    const options = pending.length + 1;
    const pick = choice % options;
    if (pick === pending.length) {
      if (probe === null) {
        // A probe starts only while some seat can still call its model (the arena's rule).
        if (ledger.halted === null && !ledger.allHandedOff()) {
          probe = { cost: Math.min(probeBound, s.probeCosts[probeNo % s.probeCosts.length] ?? 0) };
          probeNo += 1;
          seen.probes += 1;
        } else if (pending.length > 0) {
          pending.shift()?.resolve();
        }
      } else {
        inFlight = pending.length;
        budget.add(probe.cost, 0);
        probe = null;
      }
      continue;
    }
    inFlight = pending.length - 1 + (probe === null ? 0 : 1);
    pending.splice(pick, 1)[0]?.resolve();
  }
  await Promise.all(loops);
  if (probe !== null) budget.add(probe.cost, 0);

  seen.runs += 1;
  if (budget.killed) seen.killed += 1;
  expect(violations).toEqual([]);
  expect(budget.spentNanoUsd).toBeLessThanOrEqual(budget.budgetNanoUsd);
  for (const c of charged) expect(c.cost).toBeLessThanOrEqual(bounds.get(c.seat) ?? 0);
  // The ledger and the call log agree: every charge is a logged line.
  const logged = log.lines.reduce((n, l) => n + (l.k === "llm_call" ? l.costNanoUsd : 0), 0);
  expect(logged).toBe(charged.reduce((n, c) => n + c.cost, 0));
  if (budget.killed) {
    expect(ledger.halted).toBe("match_budget");
    expect(handoffs.map((h) => [h.seat, h.reason])).toEqual(
      SEATS.map((x) => [x.seat, "match_budget"]),
    );
  } else {
    expect(handoffs).toEqual([]);
  }
}

describe("the match budget under every interleaving (fast-check scheduler)", () => {
  test("spend never exceeds the budget; nothing starts after the kill switch; every seat is handed off", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          maxInflight: fc.constantFrom(1, 2, 4),
          killPermille: fc.integer({ min: 0, max: 1000 }),
          carryPermille: fc.integer({ min: 0, max: 1000 }),
          turns: fc.integer({ min: 1, max: 4 }),
          outcomes: fc.array(outcome, { minLength: 1, maxLength: 24 }),
          probeCosts: fc.array(fc.nat({ max: 400_000_000 }), { minLength: 1, maxLength: 6 }),
          choices: fc.array(fc.nat({ max: 1000 }), { minLength: 1, maxLength: 64 }),
        }),
        play,
      ),
      { numRuns: 200, seed: 4242 },
    );
    // The runs covered both outcomes, kills with attempts and a probe still in flight, and
    // real traffic (a vacuous property would pass too).
    expect(seen.killed).toBeGreaterThan(10);
    expect(seen.runs - seen.killed).toBeGreaterThan(10);
    expect(seen.killedMidFlight).toBeGreaterThan(10);
    expect(seen.inFlightAtKill).toBeGreaterThanOrEqual(3);
    expect(seen.attempts).toBeGreaterThan(1000);
    expect(seen.probes).toBeGreaterThan(50);
  }, 120_000);

  test("a kill threshold of 0 stops every seat before its first attempt", async () => {
    await play({
      maxInflight: 4,
      killPermille: 0,
      carryPermille: 0,
      turns: 2,
      outcomes: [
        { kind: "reply", calls: 1, promptPermille: 500, split: [1, 1, 1, 1], outputPermille: 500 },
      ],
      probeCosts: [1],
      choices: [0],
    });
  });
});
