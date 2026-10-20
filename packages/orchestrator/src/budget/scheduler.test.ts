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
// Pass 1b runs the same property on a mixed lineup (Sonnet 5.5, GPT-6.1 Sol, Gemini 4 Argon, GLM-5.3
// on OpenRouter with its 5.5% fee) at 32 768 output tokens (65 536 on the max_tokens retry), each
// seat billed at its provider's card for the attempt's wall-clock start, the clock crossing Argon's
// price change mid-run: the bounds, computed at the start over every card valid from then on, hold.

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { PlayerId, RoundInput, SeatAgent, Sleep, TimeSource } from "@perfidia/protocol";
import { MemoryCallLog } from "../log/calls.ts";
import { ModelError, type ChatRequest, type ModelSpec, type UsageEntry } from "../model/adapter.ts";
import { FakeAdapter, type FakeReply, type IntendedModel } from "../model/fake.ts";
import { costOf, pricerFor, type Pricer } from "../model/prices.ts";
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
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface SeatConfig {
  readonly seat: PlayerId;
  readonly model: string;
  /** Pass 1b: the provider and endpoint the seat is billed by; absent: phase 2's Claude pricing. */
  readonly billed?: IntendedModel;
}

interface Config {
  readonly seats: readonly SeatConfig[];
  readonly maxTokens: number;
  /** The run's start (the bounds take every card valid from then on) and the instant after it. */
  readonly clock?: { readonly before: string; readonly after: string };
}

/** Phase 2's and Pass 1a's lineup: Claude pricing, 16 000 output tokens, no wall clock. */
const CLAUDE: Config = {
  seats: [
    { seat: "p1", model: "claude-sonnet-5-5" },
    { seat: "p2", model: "claude-haiku-5-5" },
    { seat: "p3", model: "claude-haiku-5-5" },
    { seat: "p4", model: "claude-haiku-5-5" },
  ],
  maxTokens: 16_000,
};

/** Pass 1b's mid-tier lineup, the clock crossing Gemini 4 Argon's price change (2026-11-30). */
const MIXED: Config = {
  seats: [
    {
      seat: "p1",
      model: "claude-sonnet-5-5",
      billed: { provider: "anthropic", model: "claude-sonnet-5-5", endpoint: null },
    },
    {
      seat: "p2",
      model: "gpt-6.1-sol",
      billed: { provider: "openai", model: "gpt-6.1-sol", endpoint: null },
    },
    {
      seat: "p3",
      model: "gemini-4-argon",
      billed: { provider: "google", model: "gemini-4-argon", endpoint: null },
    },
    {
      seat: "p4",
      model: "z-ai/glm-5.3",
      billed: { provider: "openrouter", model: "z-ai/glm-5.3", endpoint: "z-ai/fp8" },
    },
  ],
  maxTokens: 32_768,
  clock: { before: "2026-11-29T23:59:00.000Z", after: "2026-11-30T00:01:00.000Z" },
};
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
interface Seen {
  runs: number;
  killed: number;
  killedMidFlight: number;
  attempts: number;
  probes: number;
  inFlightAtKill: number;
  /** Logged attempts by the card they were charged at. */
  readonly cards: Map<string, number>;
  /** Attempts sent with the larger max_tokens of the retry. */
  retries: number;
  feesNanoUsd: number;
  /** Hook failures reported (the review's failing-hooks runs). */
  hookErrors: number;
}

const newSeen = (): Seen => ({
  runs: 0,
  killed: 0,
  killedMidFlight: 0,
  attempts: 0,
  probes: 0,
  inFlightAtKill: 0,
  cards: new Map(),
  retries: 0,
  feesNanoUsd: 0,
  hookErrors: 0,
});

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
  /** Mixed lineups: the attempt start (counted over all seats) from which the clock reads `after`. */
  readonly switchAt?: number;
  /**
   * Phase-4 review: the arena's hooks fail (a full disk): the kill hook throws, and so does the
   * hand-off hook of p2. The accounting must not depend on them.
   */
  readonly failingHooks?: boolean;
}

/** A few macrotask turns: every seat reaches its next attempt (or its next await). */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    // oxlint-disable-next-line no-await-in-loop -- let every seat reach its next attempt
    await new Promise((r) => setImmediate(r));
  }
}

async function play(s: Scenario, seen: Seen, cfg: Config = CLAUDE): Promise<void> {
  const SEATS = cfg.seats;
  const MAX_TOKENS = cfg.maxTokens;
  const keyOf = (x: SeatConfig) =>
    x.billed === undefined || cfg.clock === undefined
      ? {}
      : { provider: x.billed.provider, endpoint: x.billed.endpoint, from: cfg.clock.before };
  const bounds = new Map(
    SEATS.map((x) => [x.seat, seatAttemptBound(x.model, "off", MAX_TOKENS, PROMPT_CAP, keyOf(x))]),
  );
  const sample = 40_000;
  // One start check per distinct model (its group), as the arena's preflight.
  const groups = new Map(SEATS.map((x) => [x.model, x]));
  const probeBound = [...groups.values()].reduce(
    (n, x) => n + groupCheckBound(x.model, "off", sample, keyOf(x)),
    0,
  );
  const pricers = new Map<PlayerId, Pricer>();
  for (const x of SEATS) {
    if (x.billed === undefined || cfg.clock === undefined) continue;
    pricers.set(
      x.seat,
      pricerFor({
        provider: x.billed.provider,
        endpoint: x.billed.endpoint,
        fixedAt: null,
        fallbackAt: cfg.clock.before,
      }),
    );
  }
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
      if (s.failingHooks === true) throw new Error("ENOSPC: no space left on device, write");
    },
    onError: () => {
      seen.hookErrors += 1;
    },
  });
  const handoffs: HandoffNote[] = [];
  const ledger = new BudgetLedger({
    caps: new Map(SEATS.map((x) => [x.seat, 10 ** 12])),
    wakeCapNanoUsd: null,
    handoffTo: (seat) => ({ label: "bot:turtle@3", agent: idle(`bot:turtle@3 ${seat}`) }),
    onHandoff: (n) => {
      handoffs.push(n);
      if (s.failingHooks === true && n.seat === "p2") throw new Error("EIO: i/o error, write");
    },
    onError: () => {
      seen.hookErrors += 1;
    },
    match: budget,
    pricers,
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
  // The wall clock of a mixed lineup: each attempt start reads it once; it crosses the price change.
  let starts = 0;
  const wall = cfg.clock;
  const clock =
    wall === undefined
      ? { time, random: () => 0 }
      : {
          time,
          random: () => 0,
          iso: () => {
            starts += 1;
            return starts > (s.switchAt ?? 0) ? wall.after : wall.before;
          },
        };
  const rates = new RateGates({ clock, maxInflight: s.maxInflight, releaseJitterMs: 0 });
  const gate = new NoPauseGate();
  const log = new MemoryCallLog({ transcripts: false });
  /** What each attempt's reply carried, priced at the Claude cards when the seat has no pricer. */
  const charged: { seat: PlayerId; usage: readonly UsageEntry[] }[] = [];
  const agents = SEATS.map(({ seat, model, billed }) => {
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
              charged.push({ seat, usage: spent });
              resolve(new ModelError("overloaded", "SSE overloaded", { spent, retryAfterMs: 0 }));
              return;
            }
            const usage = [usageOf(model, o, maxTokens, false)];
            charged.push({ seat, usage });
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
      adapter: new FakeAdapter(spec, brain, billed === undefined ? {} : { intended: billed }),
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
  // Choices that keep picking the probe slot can leave replies pending after the last step:
  // resolve the rest in order, so every seat finishes and a stuck scheduler fails instead of hanging.
  for (let quiet = 0; done < agents.length || pending.length > 0;) {
    // oxlint-disable-next-line no-await-in-loop -- one reply at a time
    await settle();
    const first = pending.shift();
    if (first === undefined) {
      quiet += 1;
      if (quiet > 100) throw new Error(`scheduler stuck: ${done} of ${agents.length} seats done`);
      continue;
    }
    quiet = 0;
    inFlight = pending.length + (probe === null ? 0 : 1);
    first.resolve();
  }
  await Promise.all(loops);
  if (probe !== null) budget.add(probe.cost, 0);

  seen.runs += 1;
  if (budget.killed) seen.killed += 1;
  expect(violations).toEqual([]);
  expect(budget.spentNanoUsd).toBeLessThanOrEqual(budget.budgetNanoUsd);
  // Every reply is a logged line, charged at its seat's card for the attempt's start, within its
  // bound; the ledger and the call log agree.
  const lines = log.lines.flatMap((l) => (l.k === "llm_call" ? [l] : []));
  expect(lines.length).toBe(charged.length);
  for (const l of lines) {
    const x = SEATS.find((y) => y.seat === l.seat);
    const usage: UsageEntry[] = l.usage.map((u) => ({
      model: u.model,
      kind: u.kind,
      estimated: u.estimated,
      tokens: {
        input: u.input,
        cacheWrite5m: u.cacheWrite5m,
        cacheWrite1h: u.cacheWrite1h,
        cacheRead: u.cacheRead,
        output: u.output,
      },
    }));
    const cost =
      x?.billed === undefined || wall === undefined
        ? costOf(usage)
        : costOf(usage, {
            provider: x.billed.provider,
            endpoint: x.billed.endpoint,
            at: l.wallStart ?? wall.before,
          });
    expect([l.seat, l.costNanoUsd, l.feeNanoUsd ?? 0]).toEqual([
      l.seat,
      cost.nanoUsd,
      cost.feeNanoUsd,
    ]);
    expect(cost.unpriced).toEqual([]);
    expect(l.costNanoUsd).toBeLessThanOrEqual(bounds.get(l.seat) ?? 0);
    if (l.priceCard !== undefined)
      seen.cards.set(l.priceCard, (seen.cards.get(l.priceCard) ?? 0) + 1);
    if (l.maxTokens > MAX_TOKENS) seen.retries += 1;
    seen.feesNanoUsd += l.feeNanoUsd ?? 0;
  }
  const brainUsage = (seat: PlayerId) =>
    charged.filter((c) => c.seat === seat).map((c) => JSON.stringify(c.usage[0]?.tokens));
  const loggedUsage = (seat: PlayerId) =>
    lines
      .filter((l) => l.seat === seat)
      .map((l) => {
        const u = l.usage[0];
        return JSON.stringify(
          u === undefined
            ? undefined
            : {
                input: u.input,
                cacheWrite5m: u.cacheWrite5m,
                cacheWrite1h: u.cacheWrite1h,
                cacheRead: u.cacheRead,
                output: u.output,
              },
        );
      });
  for (const x of SEATS) {
    expect(loggedUsage(x.seat).toSorted(byText)).toEqual(brainUsage(x.seat).toSorted(byText));
  }
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
    const seen = newSeen();
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
        (sc) => play(sc, seen),
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

  test("the same, with the arena's kill and hand-off hooks failing (review: a full disk)", async () => {
    const seen = newSeen();
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
          failingHooks: fc.constant(true),
        }),
        (sc) => play(sc, seen),
      ),
      { numRuns: 100, seed: 1919 },
    );
    expect(seen.killed).toBeGreaterThan(10);
    expect(seen.killedMidFlight).toBeGreaterThan(5);
    expect(seen.hookErrors).toBeGreaterThan(10);
  }, 120_000);

  test("a kill threshold of 0 stops every seat before its first attempt", async () => {
    await play(
      {
        maxInflight: 4,
        killPermille: 0,
        carryPermille: 0,
        turns: 2,
        outcomes: [
          {
            kind: "reply",
            calls: 1,
            promptPermille: 500,
            split: [1, 1, 1, 1],
            outputPermille: 500,
          },
        ],
        probeCosts: [1],
        choices: [0],
      },
      newSeen(),
    );
  });

  test("Pass 1b: a mixed lineup, each seat at its provider's card for the attempt's start, across a price change", async () => {
    const seen = newSeen();
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
          switchAt: fc.integer({ min: 0, max: 40 }),
        }),
        (sc) => play(sc, seen, MIXED),
      ),
      { numRuns: 150, seed: 2626 },
    );
    expect(seen.killed).toBeGreaterThan(10);
    expect(seen.runs - seen.killed).toBeGreaterThan(10);
    expect(seen.killedMidFlight).toBeGreaterThan(10);
    expect(seen.attempts).toBeGreaterThan(800);
    // Both of Argon's cards were charged, the 65 536-token retry was sent, the fee was paid.
    expect(seen.cards.get("google:gemini-4-argon@2026-10-20") ?? 0).toBeGreaterThan(10);
    expect(seen.cards.get("google:gemini-4-argon@2026-10-20#from2026-11-30") ?? 0).toBeGreaterThan(
      10,
    );
    expect([...seen.cards.keys()].toSorted(byText)).toEqual([
      "anthropic:claude-sonnet-5-5@2026-10-20",
      "google:gemini-4-argon@2026-10-20",
      "google:gemini-4-argon@2026-10-20#from2026-11-30",
      "openai:gpt-6.1-sol@2026-10-20",
      "openrouter:z-ai/glm-5.3(z-ai/fp8)@2026-10-20",
    ]);
    expect(seen.retries).toBeGreaterThan(10);
    expect(seen.feesNanoUsd).toBeGreaterThan(0);
  }, 120_000);
});
