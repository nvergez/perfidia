import { describe, expect, test } from "bun:test";
import { LogLineSchema, type LogLine } from "@perfidia/protocol";
import { LlmCallLineSchema, type LlmCallLine } from "../log/schema.ts";
import { formatUsd } from "../model/prices.ts";
import {
  BOT_DAY_PROFILE,
  PROJECTION_MARGIN_PCT,
  costRows,
  daysCovered,
  estimateSeat,
  projectSpend,
} from "./cost.ts";
import { controllerAt, controllerSpans, exitCriterion, recommendedSpeed } from "./report.ts";

// The arena's cost figures and report folds (phase-2 design §5.4, §5.5, §6).

const usd = (nano: number): number => Math.round(nano / 10_000_000) / 100;

const header: LogLine = LogLineSchema.parse({
  k: "header",
  format: "perfidia-log/1",
  engine: "1.0.0",
  setup: {
    ruleset: "perfidia-1@1.1.0",
    overrides: {},
    seed: 1,
    idKey: "0123456789abcdef0123456789abcdef",
    seats: [{ id: "p1" }, { id: "p2" }, { id: "p3" }],
  },
  config: {},
  configHash: "0".repeat(64),
  rulesHash: "0".repeat(64),
  controllers: {
    p1: "llm:fake/m/medium:odysseus@1:p1",
    p2: "bot:turtle@3",
    p3: "llm:fake/m/medium:penelope@1:p1",
  },
  clock: { kind: "lockstep", maxTurnsPerSecond: 3 },
  initialHash: "0".repeat(16),
});
const ev = (t: number, type: string, data: Record<string, unknown>): LogLine =>
  LogLineSchema.parse({ k: "ev", t, e: { t, type, public: true, to: [], data } });
const controller = (t: number, seat: string, label: string): LogLine =>
  LogLineSchema.parse({ k: "controller", t, seat, label });

/** An `llm_call` line with one usage entry. */
const call = (seat: string, model: string, output: number): LlmCallLine =>
  LlmCallLineSchema.parse({
    k: "llm_call",
    seat,
    turn: 1,
    round: 0,
    attempt: 1,
    kind: "round",
    t: 0,
    latencyMs: 0,
    ttftMs: null,
    provider: "anthropic",
    model,
    servedBy: model,
    effort: "medium",
    maxTokens: 16000,
    stop: "end_turn",
    rawStop: "end_turn",
    refusal: null,
    fallback: false,
    cacheMiss: false,
    usage: [
      {
        model,
        kind: "message",
        input: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        cacheRead: 1000,
        output,
        estimated: false,
      },
    ],
    costNanoUsd: 0,
    seatSpentNanoUsd: 0,
    capNanoUsd: 1,
    wakeSpentNanoUsd: 0,
    unpriced: [],
    calls: 0,
    textChars: 0,
    reasoningChars: 0,
    requestId: null,
    error: null,
  });

describe("the a-priori estimate reproduces the design's table (§5.4)", () => {
  test("Opus 5.5 at medium, 4 seats, 7 days", () => {
    const lock = estimateSeat("claude-opus-5-5", 7, "lockstep", "5m");
    expect(usd(4 * lock.central)).toBe(83.29);
    expect(usd(4 * lock.low)).toBe(23.91);
    expect(usd(4 * lock.high)).toBe(306.6);
    // Real time with a 5-minute TTL finds the prefix cold on every wake; a 1-hour TTL brings it back.
    expect(usd(4 * estimateSeat("claude-opus-5-5", 7, "realtime", "5m").central)).toBe(99.13);
    expect(usd(4 * estimateSeat("claude-opus-5-5", 7, "realtime", "1h").central)).toBe(85.77);
    // One calibration day.
    expect(usd(4 * estimateSeat("claude-opus-5-5", 1, "lockstep", "5m").central)).toBe(11.9);
  });

  test("Sonnet 5.5 and Haiku 5.5", () => {
    expect(usd(4 * estimateSeat("claude-sonnet-5-5", 7, "lockstep", "5m").central)).toBe(43.8);
    expect(usd(4 * estimateSeat("claude-haiku-5-5", 7, "lockstep", "5m").central)).toBe(2.19);
    expect(() => estimateSeat("claude-unknown", 7, "lockstep", "5m")).toThrow("no price");
  });
});

describe("the projection of a measured run (§5.5)", () => {
  test("scaled by the bots' per-day profile, plus 15%", () => {
    const week = BOT_DAY_PROFILE.reduce((a, b) => a + b, 0);
    const day1 = BOT_DAY_PROFILE[0] ?? 1;
    expect(projectSpend(1_000_000_000, 1, 7)).toBe(
      Math.round((1_000_000_000 * week * (100 + PROJECTION_MARGIN_PCT)) / (day1 * 100)),
    );
    // Day 1 is light: one measured day projects to ~9.3 days' worth of it.
    expect(formatUsd(projectSpend(1_000_000_000, 1, 7))).toBe("$9.268249");
    expect(projectSpend(5, 7, 7)).toBe(5);
    expect(projectSpend(5, 0, 7)).toBe(0);
    // Beyond the profile's 7 days, the last day repeats.
    expect(projectSpend(1_000_000, 7, 8)).toBeGreaterThan(projectSpend(1_000_000, 7, 7));
    // A partial day counts for its share: half a day's spend projects as a whole day's twice over.
    const day = projectSpend(1_000_000_000, 1, 7);
    expect(Math.abs(projectSpend(500_000_000, 0.5, 7) - day)).toBeLessThanOrEqual(1);
    expect(Math.abs(projectSpend(1_000_000_000, 1 / 24, 7) - 24 * day)).toBeLessThanOrEqual(24);
    expect(daysCovered(3600)).toBeCloseTo(1 / 24, 12);
    expect(daysCovered(2 * 86_400)).toBe(2);
  });
});

describe("report folds", () => {
  test("recommended real-time speed: 3600 / (10 × 1.5 × p95)", () => {
    expect(recommendedSpeed(120_000)).toEqual({ p95ThinkMs: 120_000, num: 2, den: 1, approx: 2 });
    expect(recommendedSpeed(180_000)).toMatchObject({ num: 4, den: 3, approx: 1.33 });
    expect(recommendedSpeed(0)).toBeNull();
  });

  test("the exit criterion: alliances formed and betrayals, overall and with an LLM seat at the time", () => {
    const lines: LogLine[] = [
      header,
      ev(100, "pact_signed", { a: "p1", b: "p2" }),
      ev(200, "alliance_formed", { alliance: "a1", name: "Ring", members: ["p2", "p3"] }),
      ev(300, "betrayal", { by: "p2", against: "p3", relation: "ally", city: "c3" }),
      controller(400, "p3", "bot:turtle@3"),
      ev(500, "betrayal", { by: "p1", against: "p3", relation: "pact", city: "c3" }),
    ];
    const spans = controllerSpans(lines);
    expect(controllerAt(spans, "p3", 399)).toBe("llm:fake/m/medium:penelope@1:p1");
    expect(controllerAt(spans, "p3", 400)).toBe("bot:turtle@3");
    const e = exitCriterion(lines);
    expect([e.alliancesFormed, e.betrayals, e.met]).toEqual([1, 2, true]);
    // p3 is an LLM at 300 (the victim), a bot at 500; p1 is an LLM throughout (the betrayer).
    expect(e.llm).toEqual({ alliances: 1, asBetrayer: 1, asVictim: 1, betrayals: 2, met: true });
    expect(e.events.map((x) => [x.type, x.seats, x.llm])).toEqual([
      ["alliance_formed", ["p2", "p3"], ["p3"]],
      ["betrayal", ["p2", "p3"], ["p3"]],
      ["betrayal", ["p1", "p3"], ["p1"]],
    ]);
    // A pact is not an alliance; no betrayal: not met.
    expect(exitCriterion([header, ev(1, "pact_signed", { a: "p1", b: "p2" })]).met).toBe(false);
  });

  test("cost rows per seat and billed model", () => {
    const rows = costRows([
      call("p2", "claude-opus-5-5", 10),
      call("p10", "claude-opus-5-5", 1),
      call("p2", "claude-opus-5", 10),
      call("p2", "claude-opus-5-5", 5),
    ]);
    expect(rows.map((r) => [r.seat, r.model, r.calls, r.output, r.nanoUsd])).toEqual([
      ["p2", "claude-opus-5", 1, 10, 1000 * 500 + 10 * 25_000],
      ["p2", "claude-opus-5-5", 2, 15, 2000 * 200 + 15 * 20_000],
      ["p10", "claude-opus-5-5", 1, 1, 1000 * 200 + 20_000],
    ]);
  });
});
