// LLM seats in a real match (phase-2 design §7 items 4 and 7, the parts this step owns): four
// `LlmSeatAgent`s on fake models and two bots play perfidia-1 under the lockstep clock through
// `runMatch`. Checked:
// - cache-prefix stability: every request goes through the real `AnthropicAdapter.build()`; the
//   tools and `system[0]` bytes are identical for every seat and wake of one model, `system[1]` for
//   every wake of a seat, and each request of a turn extends the previous one;
// - Level E holds, thoughts reach the `turn` lines, one `llm_call` line per request, and the ledger
//   equals the sum of the lines;
// - determinism: two runs give identical logs;
// - the ledger as the gateway's hand-off queue: a seat over its cap is handed to its bot with a
//   `controller` line, and no model call follows.

import { describe, expect, test } from "bun:test";
import { botFromLabel } from "@perfidia/bots";
import { createMatch, getRuleset, verifyLog } from "@perfidia/engine";
import { canonicalJson, idKeyFromSeed } from "@perfidia/engine/core";
import { rulesInfo } from "@perfidia/gateway/present";
import { MemorySink, runMatch, toolDefinitions } from "@perfidia/gateway/runtime";
import type { LogLine, MatchSetup, PlayerId, SeatAgent } from "@perfidia/protocol";
import { BudgetLedger } from "./budget/ledger.ts";
import { MemoryCallLog } from "./log/calls.ts";
import type { ChatRequest, ModelSpec } from "./model/adapter.ts";
import { AnthropicAdapter, AnthropicClient } from "./model/anthropic.ts";
import { seededRandom } from "./model/clock.ts";
import { FakeAdapter, type FakeReply } from "./model/fake.ts";
import { RateGates } from "./model/rate.ts";
import { anthropicTools } from "./model/tools.ts";
import { LOCKSTEP_POLICY, LlmSeatAgent } from "./seat/agent.ts";
import { NoPauseGate } from "./seat/pause.ts";
import { PROFILES } from "./seat/personalities.ts";
import { seatPrompt, sharedPrompt } from "./seat/prompt.ts";
import { virtualTime } from "./testkit.test.ts";

const RULESET = getRuleset("perfidia-1@1.1.0");
const LLM: readonly PlayerId[] = ["p1", "p2", "p3", "p4"];
const BOTS: readonly (readonly [PlayerId, string])[] = [
  ["p5", "bot:opportunist@3"],
  ["p6", "bot:conqueror@3"],
];
const SEATS: readonly PlayerId[] = ["p1", "p2", "p3", "p4", "p5", "p6"];

const FAKE: ModelSpec = {
  provider: "fake",
  model: "claude-opus-5-5",
  effort: "medium",
  maxOutputTokens: 16_000,
  cacheTtl: "5m",
};

/** A stateless brain: look at the first city and note it, then end the turn with a thought. */
function brain(req: ChatRequest): FakeReply {
  const first = req.entries[0];
  const json =
    first?.role === "user" && first.parts[0]?.kind === "text" ? first.parts[0].text : "{}";
  const briefing: unknown = JSON.parse(json);
  const cities: unknown =
    briefing !== null && typeof briefing === "object" ? Reflect.get(briefing, "cities") : [];
  const city: unknown =
    Array.isArray(cities) && cities[0] !== null && typeof cities[0] === "object"
      ? Reflect.get(cities[0], "id")
      : null;
  if (req.meta.round === 0 && typeof city === "string") {
    return {
      reasoning: ["Check the home city first."],
      calls: [
        { name: "view_city", args: { city } },
        {
          name: "write_note",
          args: { mode: "append", text: `seen ${city} at turn ${req.meta.turn}` },
        },
      ],
    };
  }
  return {
    text: [`Turn ${req.meta.turn}: I build and wait.`],
    calls: [{ name: "end_turn", args: { nextWakeIn: 3600 } }],
  };
}

interface Run {
  readonly lines: LogLine[];
  readonly calls: MemoryCallLog;
  readonly fakes: ReadonlyMap<PlayerId, FakeAdapter>;
  readonly ledger: BudgetLedger;
}

async function play(o: { readonly capP2?: number; readonly hours?: number } = {}): Promise<Run> {
  const setup: MatchSetup = {
    ruleset: RULESET.ref,
    overrides: { "time.matchEnd": (o.hours ?? 6) * 3600 },
    seed: 11,
    idKey: idKeyFromSeed(11),
    seats: SEATS.map((id) => ({ id })),
  };
  const info = rulesInfo(createMatch(setup, RULESET));
  const shared = sharedPrompt(info, setup.seats.length);
  const tools = anthropicTools(toolDefinitions(RULESET));
  const time = virtualTime();
  const clock = { time, random: seededRandom(setup.seed) };
  const calls = new MemoryCallLog();
  const gate = new NoPauseGate();
  const rates = new RateGates({ clock });
  const ledger = new BudgetLedger({
    caps: new Map(LLM.map((s) => [s, s === "p2" ? (o.capP2 ?? 100_000_000_000) : 100_000_000_000])),
    wakeCapNanoUsd: 2_000_000_000,
    handoffTo: (seat) => {
      const label = "bot:turtle@3";
      const agent = botFromLabel(label, { seat, seed: setup.seed });
      if (agent === null) throw new Error(`no bot ${label}`);
      return { label, agent };
    },
    onHandoff: (n) =>
      calls.write({
        k: "handoff",
        seat: n.seat,
        t: n.t,
        reason: n.reason,
        label: n.label,
        spentNanoUsd: n.spentNanoUsd,
        capNanoUsd: n.capNanoUsd,
      }),
  });
  const fakes = new Map<PlayerId, FakeAdapter>();
  const agents = new Map<PlayerId, SeatAgent>();
  for (const [i, seat] of LLM.entries()) {
    const fake = new FakeAdapter(FAKE, brain);
    fakes.set(seat, fake);
    const profile = PROFILES[i];
    if (profile === undefined) throw new Error("no profile");
    agents.set(
      seat,
      new LlmSeatAgent({
        seat,
        adapter: fake,
        prompt: { shared, seat: seatPrompt(seat, profile) },
        tools,
        profile,
        ledger,
        log: calls,
        clock,
        gate,
        rate: rates.gate(FAKE.provider, FAKE.model),
        policy: LOCKSTEP_POLICY,
      }),
    );
  }
  for (const [seat, label] of BOTS) {
    const agent = botFromLabel(label, { seat, seed: setup.seed });
    if (agent === null) throw new Error(`no bot ${label}`);
    agents.set(seat, agent);
  }
  const sink = new MemorySink();
  await time.run(() =>
    runMatch({
      setup,
      ruleset: RULESET,
      agents,
      clock: { kind: "lockstep" },
      sink,
      handoffQueue: ledger,
      invariants: "checkpoint",
    }),
  );
  return { lines: sink.parsed(), calls, fakes, ledger };
}

const builder = new AnthropicAdapter(
  { ...FAKE, provider: "anthropic" },
  new AnthropicClient({
    apiKey: "sk-never-used",
    baseURL: "https://api.test.invalid",
    fetch: () => Promise.reject(new Error("no network in tests")),
  }),
);

describe("LLM seats in a real lockstep match", () => {
  test("cache-prefix stability, Level E, thoughts, one llm_call line per request, ledger = lines", async () => {
    const run = await play();
    const report = verifyLog(run.lines, (ref) => (ref === RULESET.ref ? RULESET : undefined));
    expect(report.divergence).toBeUndefined();
    expect(report.ok).toBe(true);
    expect(run.lines.some((l) => l.k === "fatal")).toBe(false);
    expect(run.lines.at(-1)?.k).toBe("end");

    const tools = new Set<string>();
    const shared = new Set<string>();
    let requests = 0;
    for (const [seat, fake] of run.fakes) {
      const seatBlocks = new Set<string>();
      let prev: { turn: number; messages: unknown[] } | null = null;
      for (const req of fake.requests) {
        requests += 1;
        const body = builder.build(req);
        tools.add(JSON.stringify(body.tools));
        shared.add(JSON.stringify(body.system?.[0]));
        seatBlocks.add(JSON.stringify(body.system?.[1]));
        expect(JSON.stringify(body.system)).toContain('"cache_control":{"type":"ephemeral"}');
        const parsed: unknown = JSON.parse(JSON.stringify(body.messages));
        const messages: unknown[] = Array.isArray(parsed) ? parsed : [];
        if (prev !== null && prev.turn === req.meta.turn) {
          expect(messages.slice(0, prev.messages.length)).toEqual(prev.messages);
        }
        prev = { turn: req.meta.turn, messages };
      }
      expect([seat, seatBlocks.size]).toEqual([seat, 1]);
      expect(fake.requests.length).toBeGreaterThan(4);
    }
    expect(tools.size).toBe(1);
    expect(shared.size).toBe(1);

    const turnLines = run.lines.filter((l) => l.k === "turn" && LLM.includes(l.seat));
    expect(turnLines.length).toBeGreaterThan(8);
    for (const l of turnLines) {
      if (l.k === "turn") expect(l.thought).toBe(`Turn ${l.turn}: I build and wait.`);
    }
    const llm = run.calls.lines.filter((l) => l.k === "llm_call");
    expect(llm).toHaveLength(requests);
    const total = llm.reduce((n, l) => (l.k === "llm_call" ? n + l.costNanoUsd : n), 0);
    expect(total).toBe(LLM.reduce((n, s) => n + run.ledger.spent(s), 0));
    // Every act and gw line of an LLM seat comes from a model call: none is INTERNAL.
    expect(run.lines.some((l) => l.k === "gw" && l.r.code === "INTERNAL")).toBe(false);
  });

  test("deterministic: two runs give identical match logs and llm_calls lines", async () => {
    const [a, b] = [await play(), await play()];
    expect(a.lines.map((l) => canonicalJson(l))).toEqual(b.lines.map((l) => canonicalJson(l)));
    expect(a.calls.lines).toEqual(b.calls.lines);
  });

  test("a seat over its cap is handed to its bot: a controller line, then no model call", async () => {
    // p2 crosses its cap on its first call and sets no self-wake: its next turn is the safety
    // wake, 12 h later, which opens with the controller line.
    const run = await play({ capP2: 1, hours: 14 });
    expect(run.lines.filter((l) => l.k === "controller")).toHaveLength(1);
    const c = run.lines.find((l) => l.k === "controller");
    expect(c?.k === "controller" ? [c.seat, c.label] : []).toEqual(["p2", "bot:turtle@3"]);
    const handoffs = run.calls.lines.filter((l) => l.k === "handoff");
    expect(handoffs).toHaveLength(1);
    const lastP2 = run.calls.lines.findLast((l) => l.k === "llm_call" && l.seat === "p2");
    expect(lastP2?.k === "llm_call" && c?.k === "controller" ? lastP2.t <= c.t : false).toBe(true);
    const report = verifyLog(run.lines, (ref) => (ref === RULESET.ref ? RULESET : undefined));
    expect(report.ok).toBe(true);
  });
});
