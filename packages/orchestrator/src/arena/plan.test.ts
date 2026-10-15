import { describe, expect, test } from "bun:test";
import { UsageError } from "@perfidia/sim";
import {
  DEFAULT_CAP_NANO_USD,
  DEFAULT_WAKE_CAP_NANO_USD,
  lockstepRoundTimeoutMs,
} from "../defaults.ts";
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

  test("an unpriced model is refused at plan time", () => {
    expect(usage({ seats: ["p1=claude:claude-opus-9:low:odysseus"] })).toContain(
      "no price for model claude-opus-9",
    );
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
    expect(plan({}, { ...KEY, baseURL: "http://localhost:9999" }).baseURL).toBe(
      "http://localhost:9999",
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
  });
});
