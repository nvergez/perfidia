import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageError } from "@perfidia/sim";
import { centralWakeNano } from "./cost.ts";
import { lineupPath } from "./lineup.ts";
import {
  DEFAULT_CAP_NANO_USD,
  DEFAULT_WAKE_CAP_NANO_USD,
  lockstepRoundTimeoutMs,
} from "../defaults.ts";
import { LineupSchema } from "../log/schema.ts";
import {
  arenaEnv,
  llmSeatsOf,
  parseDuration,
  planArena,
  type ArenaEnv,
  type ArenaRequest,
} from "./plan.ts";

// `arena run` plans (phase-2 design §7, item 10): the seat-spec grammar, the defaults, the error
// messages (exit code 3), refusing an unpriced model or a missing key, the derived timeouts.

const NO_KEY: ArenaEnv = { apiKey: null, baseURL: null, live: false };
const KEY: ArenaEnv = { apiKey: "sk-test", baseURL: null, live: false };
const fixed = { randomSeed: () => 42, randomKey: () => "0123456789abcdef0123456789abcdef" };

const plan = (req: ArenaRequest, env: ArenaEnv = KEY) => planArena(req, env, fixed);

/** The lineup default wake cap of `m` (§3.9): 20 × its central wake. */
const wake = (m: string): number => 20 * centralWakeNano(m, "lockstep", "5m");

function usage(req: ArenaRequest, env: ArenaEnv = KEY): string {
  try {
    plan(req, env);
  } catch (e) {
    if (e instanceof UsageError) return e.message;
    throw e;
  }
  throw new Error("expected a UsageError");
}

describe("arena plan", () => {
  test("the defaults: 4 Opus 5.5 seats at medium with the four profiles, two bots, lockstep, a week", () => {
    const p = plan({});
    expect(p.setup.ruleset).toBe("perfidia-1@1.1.0");
    expect(p.setup.seed).toBe(42);
    expect(p.setup.idKey).toBe("0123456789abcdef0123456789abcdef");
    expect(p.setup.overrides["time.matchEnd"]).toBe(7 * 86400);
    expect(
      p.seats.map((s) => (s.kind === "bot" ? s.label : `${s.model}/${s.effort}/${s.profile.id}`)),
    ).toEqual([
      "claude-opus-5-5/medium/odysseus",
      "claude-opus-5-5/medium/achilles",
      "claude-opus-5-5/medium/penelope",
      "claude-opus-5-5/medium/agamemnon",
      "bot:opportunist@3",
      "bot:conqueror@3",
    ]);
    expect(llmSeatsOf(p).map((s) => [s.capNanoUsd, s.handoffBot])).toEqual([
      [DEFAULT_CAP_NANO_USD, "bot:opportunist@3"],
      [DEFAULT_CAP_NANO_USD, "bot:conqueror@3"],
      [DEFAULT_CAP_NANO_USD, "bot:turtle@3"],
      [DEFAULT_CAP_NANO_USD, "bot:opportunist@3"],
    ]);
    expect(p.wakeCapNanoUsd).toBe(DEFAULT_WAKE_CAP_NANO_USD);
    expect(p.clock).toEqual({ kind: "lockstep", roundTimeoutMs: lockstepRoundTimeoutMs() });
    expect(p.policy).toEqual({
      retryBudgetMs: 60 * 60_000,
      attemptTimeoutMs: 10 * 60_000,
      roundDeadlineMs: 200 * 60_000 - 60_000,
      thoughtCall: false,
      promptCapTokens: 160_000,
    });
    expect([p.cacheTtl, p.time, p.fake, p.maxTokens, p.maxInflight]).toEqual([
      "5m",
      "system",
      false,
      16000,
      4,
    ]);
    expect(p.baseURL).toBe("https://api.anthropic.com");
  });

  test("the seat grammar: claude:<model>:<effort>:<profile> and bot:<strategy>[@n]", () => {
    const p = plan({
      seats: [
        "p2=claude:haiku-5-5:low:penelope",
        "p5=bot:turtle@3",
        "p6=bot:rusher",
        "p1=claude:claude-sonnet-5-5:high:achilles@1",
      ],
      seatCaps: ["p2=0.25"],
      wakeCapUsd: "off",
    });
    const llm = llmSeatsOf(p);
    expect(llm.map((s) => [s.seat, s.model, s.effort, s.profile.id])).toEqual([
      ["p1", "claude-sonnet-5-5", "high", "achilles"],
      ["p2", "claude-haiku-5-5", "low", "penelope"],
      ["p3", "claude-opus-5-5", "medium", "penelope"],
      ["p4", "claude-opus-5-5", "medium", "agamemnon"],
    ]);
    expect(llm[1]?.capNanoUsd).toBe(250_000_000);
    expect(p.seats[4]).toEqual({ seat: "p5", kind: "bot", label: "bot:turtle@3" });
    expect(p.seats[5]?.kind === "bot" ? p.seats[5].label : "").toMatch(/^bot:rusher@[0-9]+$/);
    expect(p.wakeCapNanoUsd).toBeNull();
  });

  test("seat-spec errors name the flag and say how to fix it", () => {
    expect(usage({ seats: ["p1=claude:gpt-5:low:odysseus"] })).toContain('unknown model "gpt-5"');
    expect(usage({ seats: ["p1=claude:opus-5-5:fast:odysseus"] })).toContain(
      "effort must be one of low, medium, high, xhigh, max",
    );
    expect(usage({ seats: ["p1=claude:opus-5-5:low:hector"] })).toContain(
      'unknown profile "hector"',
    );
    expect(usage({ seats: ["p1=claude:opus-5-5:low"] })).toContain(
      "claude:<model>:<effort>:<profile>",
    );
    expect(usage({ seats: ["p1=human"] })).toContain("claude:… (an LLM) or bot:…");
    expect(usage({ seats: ["p9=bot:turtle"] })).toContain("the match has seats p1..p6");
    expect(usage({ seats: ["p1=bot:turtle", "p1=bot:rusher"] })).toContain(
      "--seat p1 is given twice",
    );
    expect(usage({ seats: ["p1=bot:mystery"] })).toContain('unknown bot "mystery"');
    expect(usage({ players: 7 })).toContain("p7 has no controller");
    expect(usage({ seatCaps: ["p5=3"] })).toContain("p5 is a bot");
  });

  test("a seat runs on the 5.5 family only: fallback-only and unknown models are refused", () => {
    // Claude Sonnet 5 is priced (a fallback target) but rejects mid-conversation system messages.
    expect(usage({ seats: ["p1=claude:claude-sonnet-5:medium:odysseus"] })).toContain(
      "claude-sonnet-5 is not a seat model; a seat runs on claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5",
    );
    expect(usage({ seats: ["p1=claude:claude-opus-9:low:odysseus"] })).toContain(
      "claude-opus-9 is not a seat model",
    );
  });

  test("USD amounts stay exact integers: at most $1 000 000, before anything is sent", () => {
    expect(usage({ capUsd: "10000000" })).toContain("--cap-usd must be at most 1000000");
    expect(usage({ seatCaps: ["p1=1e9"] })).toContain("--seat-cap p1 must be");
    expect(llmSeatsOf(plan({ capUsd: "1000000" }))[0]?.capNanoUsd).toBe(1e15);
  });

  test("LLM seats need the key unless --fake; the base URL must be http(s)", () => {
    const m = usage({}, NO_KEY);
    expect(m).toContain("PERFIDIA_ANTHROPIC_API_KEY is not set");
    expect(m).toContain("--fake");
    expect(plan({ fake: true }, NO_KEY).fake).toBe(true);
    expect(
      plan({ seats: ["p1=bot:turtle", "p2=bot:turtle", "p3=bot:turtle", "p4=bot:turtle"] }, NO_KEY)
        .seats,
    ).toHaveLength(6);
    expect(usage({}, { ...KEY, baseURL: "ftp://x" })).toContain("not an http(s) URL");
    // http:// only on loopback: the key would cross the network in cleartext.
    for (const local of ["http://localhost:9999", "http://127.0.0.1:8080/", "http://[::1]:1"]) {
      expect(plan({}, { ...KEY, baseURL: local }).baseURL).toBe(local);
    }
    expect(usage({}, { ...KEY, baseURL: "http://proxy.example.com" })).toContain(
      "is http:// on proxy.example.com: the API key would cross the network in cleartext",
    );
    expect(plan({}, { ...KEY, baseURL: "https://proxy.example.com" }).baseURL).toBe(
      "https://proxy.example.com",
    );
  });

  test("the environment: only PERFIDIA_ANTHROPIC_API_KEY, PERFIDIA_ANTHROPIC_BASE_URL and PERFIDIA_LIVE", () => {
    const junk = {
      ANTHROPIC_API_KEY: "sk-junk",
      ANTHROPIC_BASE_URL: "https://junk.invalid",
      ANTHROPIC_AUTH_TOKEN: "junk",
    };
    expect(arenaEnv(junk)).toEqual({ apiKey: null, baseURL: null, live: false });
    expect(
      arenaEnv({
        ...junk,
        PERFIDIA_ANTHROPIC_API_KEY: " sk-a ",
        PERFIDIA_ANTHROPIC_BASE_URL: "",
        PERFIDIA_LIVE: "1",
      }),
    ).toEqual({ apiKey: "sk-a", baseURL: null, live: true });
  });

  test("real time: --speed required with real models; deadlines and budgets derived; TTL 1 h", () => {
    expect(usage({ clock: "realtime" })).toContain("--clock realtime needs --speed");
    const p = plan({ clock: "realtime", speed: { num: 2, den: 1 } });
    expect(p.clock).toEqual({
      kind: "realtime",
      speed: { num: 2, den: 1 },
      turnTimeoutMs: 300_000,
      botLatencyMs: [20_000, 90_000],
    });
    expect(p.policy).toEqual({
      retryBudgetMs: 290_000,
      attemptTimeoutMs: 290_000,
      roundDeadlineMs: 290_000,
      thoughtCall: false,
      promptCapTokens: 160_000,
    });
    expect(p.cacheTtl).toBe("1h");
    expect(plan({ clock: "realtime", fake: true }).clock).toMatchObject({
      speed: { num: 3, den: 1 },
    });
    expect(plan({ clock: "realtime", fake: true }).time).toBe("virtual");
    expect(usage({ clock: "realtime", speed: { num: 2, den: 1 }, retryBudgetMs: 1000 })).toContain(
      "--retry-budget applies to --clock lockstep only",
    );
    expect(usage({ speed: { num: 2, den: 1 } })).toContain(
      "--speed applies to --clock realtime only",
    );
    expect(usage({ time: "virtual" })).toContain(
      "--time virtual simulates the clock: it needs --fake",
    );
  });

  test("lockstep: the round timeout covers the retry budget, the pause and two attempts", () => {
    const p = plan({
      retryBudgetMs: 30 * 60_000,
      pauseMaxMs: 15 * 60_000,
      attemptTimeoutMs: 5 * 60_000,
    });
    expect(p.clock).toEqual({ kind: "lockstep", roundTimeoutMs: (30 + 15 + 10) * 60_000 });
    expect(p.policy.roundDeadlineMs).toBe((30 + 15 + 10) * 60_000 - 60_000);
    expect(p.pauseMaxMs).toBe(15 * 60_000);
  });

  test("--stop-after N: the run stops at the end of day N, the match keeps its length", () => {
    const p = plan({ stopAfterDays: 1 });
    expect(p.stopAt).toBe(86_400);
    expect(p.setup.overrides["time.matchEnd"]).toBe(7 * 86_400);
    expect(plan({}).stopAt).toBeNull();
    expect(plan({ days: 3, stopAfterDays: 2 }).stopAt).toBe(2 * 86_400);
    expect(usage({ stopAfterDays: 7 })).toContain(
      "--stop-after must be a whole number of game days from 1 to 6 (the match lasts 7 days)",
    );
    expect(usage({ days: 1, stopAfterDays: 1 })).toContain(
      "--stop-after needs a match longer than one day (this one lasts 1 days)",
    );
  });

  test("length: --days, or --override time.matchEnd, never both", () => {
    expect(plan({ days: 2 }).setup.overrides["time.matchEnd"]).toBe(2 * 86400);
    expect(plan({ overrides: ["time.matchEnd=3600"] }).setup.overrides["time.matchEnd"]).toBe(3600);
    expect(usage({ days: 2, overrides: ["time.matchEnd=3600"] })).toContain("keep one");
  });

  test("hand-off bot, fake brains, id keys", () => {
    const p = plan({ handoffBot: "turtle@3", fake: true, brains: ["p3=expander@2"] });
    expect(llmSeatsOf(p).map((s) => [s.handoffBot, s.brain])).toEqual([
      ["bot:turtle@3", "bot:turtle@3"],
      ["bot:turtle@3", "bot:turtle@3"],
      ["bot:turtle@3", "bot:expander@2"],
      ["bot:turtle@3", "bot:turtle@3"],
    ]);
    expect(usage({ brains: ["p1=turtle@3"] })).toContain("--brain applies to --fake runs only");
    expect(usage({ fake: true, brains: ["p5=turtle@3"] })).toContain("p5 is a bot");
    expect(plan({ idKey: "seed", seed: 9 }).setup.idKey).not.toBe(
      "0123456789abcdef0123456789abcdef",
    );
    expect(usage({ idKey: "xyz" })).toContain("--id-key must be 32 lowercase hex characters");
  });

  test("durations", () => {
    expect([
      parseDuration("90s", "--x"),
      parseDuration("5m", "--x"),
      parseDuration("2h", "--x"),
      parseDuration("1500", "--x"),
      parseDuration("250ms", "--x"),
    ]).toEqual([90_000, 300_000, 7_200_000, 1500, 250]);
    expect(() => parseDuration("5 minutes", "--pause-max")).toThrow(
      "--pause-max must be a duration",
    );
    expect(() => parseDuration("0s", "--pause-max")).toThrow("positive");
    // Past 2^31 − 1 ms a runtime timer fires at once.
    expect(parseDuration("596h", "--x")).toBe(596 * 3_600_000);
    expect(() => parseDuration("597h", "--pause-max")).toThrow("at most 596h");
    expect(usage({ pauseMaxMs: 400 * 3_600_000, retryBudgetMs: 300 * 3_600_000 })).toContain(
      "the lockstep round timeout: it must stay under 596h",
    );
  });
});

describe("arena plan: lineups and the match budget (phase 4 Pass 1a)", () => {
  test("--lineup claude-duo: the seats, Sonnet 5.5 without fallbacks, the §3.9 caps, the budget", () => {
    const p = plan({ lineup: "claude-duo" });
    expect(p.lineup).toBe("claude-duo");
    expect(
      p.seats.map((s) =>
        s.kind === "bot" ? s.label : `${s.model}/${s.effort}/${s.fallbacks}/${s.profile.id}`,
      ),
    ).toEqual([
      "claude-sonnet-5-5/medium/off/odysseus",
      "claude-haiku-5-5/medium/off/achilles",
      "claude-haiku-5-5/medium/off/penelope",
      "claude-haiku-5-5/medium/off/agamemnon",
      "bot:opportunist@3",
      "bot:conqueror@3",
    ]);
    const sonnet = p.prediction.seats[0];
    // Cap: twice the seat's predicted high, at least $5; wake cap: 20 × the central wake, ≥ $0.10.
    expect(llmSeatsOf(p).map((s) => s.capNanoUsd)).toEqual([
      2 * (sonnet?.high ?? 0),
      5_000_000_000,
      5_000_000_000,
      5_000_000_000,
    ]);
    expect(llmSeatsOf(p).map((s) => s.wakeCapNanoUsd)).toEqual([
      wake("claude-sonnet-5-5"),
      wake("claude-haiku-5-5"),
      wake("claude-haiku-5-5"),
      wake("claude-haiku-5-5"),
    ]);
    // $1.92 and $0.10 (Haiku's is just over the $0.10 floor).
    expect([wake("claude-sonnet-5-5"), wake("claude-haiku-5-5")]).toEqual([
      1_919_200_000, 100_920_000,
    ]);
    expect([
      p.maxTokens,
      p.promptCapTokens,
      p.policy.promptCapTokens,
      p.policy.attemptTimeoutMs,
    ]).toEqual([16_000, 160_000, 160_000, 600_000]);
    expect(p.budget).toEqual({
      budgetNanoUsd: 55_000_000_000,
      onBudget: "handoff",
      carryNanoUsd: 0,
      carryFrom: null,
      carryLines: 0,
    });
    expect(p.estimate.budget?.killAtNanoUsd).toBe(
      55_000_000_000 - p.prediction.reserve.reserveNanoUsd,
    );
    expect(p.warnings).toEqual([]);
  });

  test("flags over the lineup: --seat, --cap-usd, --wake-cap-usd, --max-tokens, --prompt-cap, --budget-usd, --on-budget", () => {
    const p = plan(
      {
        lineup: "claude-duo",
        seats: ["p2=claude:opus-5-5:low:achilles"],
        capUsd: "7",
        wakeCapUsd: "off",
        maxTokens: 20_000,
        promptCap: 120_000,
        budgetUsd: "60",
        onBudget: "abort",
      },
      KEY,
    );
    const llm = llmSeatsOf(p);
    // The overridden seat takes the model's default fallbacks (Opus 5.5: default) and no lineup extras.
    expect(
      llm.map((s) => [s.model, s.effort, s.fallbacks, s.capNanoUsd, s.wakeCapNanoUsd]),
    ).toEqual([
      ["claude-sonnet-5-5", "medium", "off", 7_000_000_000, null],
      ["claude-opus-5-5", "low", "default", 7_000_000_000, null],
      ["claude-haiku-5-5", "medium", "off", 7_000_000_000, null],
      ["claude-haiku-5-5", "medium", "off", 7_000_000_000, null],
    ]);
    expect([p.maxTokens, p.promptCapTokens, p.budget?.budgetNanoUsd, p.budget?.onBudget]).toEqual([
      20_000,
      120_000,
      60_000_000_000,
      "abort",
    ]);
    // Without a lineup the phase-2 defaults stay, and Sonnet 5.5 seats get fallbacks off.
    const bare = plan({ seats: ["p1=claude:sonnet-5-5:medium:odysseus"] });
    expect(
      llmSeatsOf(bare).map((s) => [s.model, s.fallbacks, s.capNanoUsd, s.wakeCapNanoUsd]),
    ).toEqual([
      ["claude-sonnet-5-5", "off", DEFAULT_CAP_NANO_USD, DEFAULT_WAKE_CAP_NANO_USD],
      ["claude-opus-5-5", "default", DEFAULT_CAP_NANO_USD, DEFAULT_WAKE_CAP_NANO_USD],
      ["claude-opus-5-5", "default", DEFAULT_CAP_NANO_USD, DEFAULT_WAKE_CAP_NANO_USD],
      ["claude-opus-5-5", "default", DEFAULT_CAP_NANO_USD, DEFAULT_WAKE_CAP_NANO_USD],
    ]);
    expect([bare.budget, bare.lineup, bare.promptCapTokens]).toEqual([null, null, 160_000]);
  });

  test("lineup and budget errors name the field and the fix", () => {
    const dir = mkdtempSync(join(tmpdir(), "perfidia-lineup-"));
    try {
      const duo = LineupSchema.parse(JSON.parse(readFileSync(lineupPath("claude-duo"), "utf8")));
      const write = (name: string, value: unknown): string => {
        const p = join(dir, `${name}.json`);
        writeFileSync(p, JSON.stringify(value));
        return p;
      };
      expect(
        usage({ lineup: write("late", { ...duo, reminders: "last-round" }), fake: true }),
      ).toContain('reminders "last-round" arrive with the non-Anthropic seats');
      const haiku = {
        ...duo,
        seats: duo.seats.map((s, i) => (i === 1 ? { ...s, fallbacks: "default" } : s)),
      };
      expect(usage({ lineup: write("haiku", haiku), fake: true })).toContain(
        "p2: claude-haiku-5-5 has no server-side refusal fallback",
      );
      const gap = { ...duo, seats: duo.seats.filter((_, i) => i !== 2) };
      expect(usage({ lineup: write("gap", gap), fake: true })).toContain("p3 is missing");
      expect(usage({ lineup: write("bad", { ...duo, budgetUsd: "lots" }), fake: true })).toContain(
        "not a perfidia-lineup/1 file: budgetUsd",
      );
      expect(usage({ lineup: join(dir, "absent.json"), fake: true })).toContain(
        "no lineup file at",
      );
      expect(usage({ budgetCarry: dir, fake: true })).toContain(
        "--budget-carry needs a match budget",
      );
      expect(usage({ lineup: "claude-duo", budgetCarry: dir, fake: true })).toContain(
        "no llm_calls.jsonl",
      );
      expect(usage({ lineup: "claude-duo", onBudget: "panic", fake: true })).toContain(
        "--on-budget must be one of handoff, abort",
      );
      // A comparison lineup that repeats a model: a warning.
      const cmp = plan({ lineup: write("cmp", { ...duo, comparison: true }), fake: true });
      expect(cmp.warnings.join("\n")).toContain("repeats claude-haiku-5-5");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
