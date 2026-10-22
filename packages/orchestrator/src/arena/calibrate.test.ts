// Phase 4, Pass 2 (agent E): calibration profiles and the predictions drawn from them, on synthetic
// run directories built here (real-provider `llm_call` lines with chosen token counts; no fake run
// feeds seat-days). Checked:
// - `arena calibrate`: seat-days per key, complete days only, nothing after a hand-off, fake runs
//   skipped for seat-days and read for the briefing growth (7-day runs only), profiles accumulate
//   and a run measured again replaces its seat-days, refusals;
// - `measured-point`: phase 2's `projectSpend` (+15%) of the re-priced measured spend, low and high
//   by the scenario's ratios, never percentiles;
// - `calibrated`: the seeded bootstrap is deterministic (same seed, same figures), exact on a
//   degenerate profile (wake counts scaled by `BOT_DAY_PROFILE`, prompts grown by the briefing
//   growth), priced at the cards of the planned wall times; the match is the bootstrap of the sum
//   only when every seat is calibrated;
// - the source label in `estimate.json` and `arena.json` (`arena run --fake --profiles`).
// The calibrated fake run runs in the slow suite (PERFIDIA_SLOW=1, docs/architecture.md §13.8:
// `bun run test:slow`, run by `bun run test:exit`).

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DAY } from "@perfidia/engine/core";
import {
  ArenaReportSchema,
  EstimateFileSchema,
  LlmCallLineSchema,
  SeatsFileSchema,
  TokenProfileSchema,
  type ArenaReport,
  type LlmCallLine,
  type PlayerId,
  type PromptVariant,
  type SeatsFile,
  type TokenProfile,
} from "@perfidia/protocol";
import { UsageError, memoryIo } from "@perfidia/sim";
import { costOf, type PriceContext } from "../model/prices.ts";
import { PROFILES } from "../seat/personalities.ts";
import { PROMPT_VERSION } from "../seat/prompt.ts";
import {
  BRIEFING_BYTES_PER_TOKEN,
  calibrate,
  independentSeatDays,
  loadProfiles,
  profileFileName,
  profileKeyText,
  profilesFor,
  rulesetMajorOf,
  sourceOfProfile,
} from "./calibrate.ts";
import { main as arenaMain } from "./cli.ts";
import { BOT_DAY_PROFILE, estimateCard, projectSpend, scenarioCard } from "./cost.ts";
import {
  BOOTSTRAP_REPLICATES,
  LOCKSTEP_WALL_MS_PER_GAME_DAY,
  formatEstimate,
  plannedWallMsPerGameDay,
  predict,
  scenarioAssumptions,
  type PredictOptions,
  type PredictSeat,
} from "./estimate.ts";
import { defaultSeatCap } from "./lineup.ts";
import { arenaEnv, planArena } from "./plan.ts";
import { runDir } from "./rig.test.ts";

const SLOW = process.env["PERFIDIA_SLOW"] === "1";
/** A test of the slow suite: skipped unless PERFIDIA_SLOW=1. */
const xtest = test.skipIf(!SLOW);

/** `arena` as the CLI runs it, with no calibration profile unless a test passes `--profiles`. */
const main = (...[argv, io, env, o]: Parameters<typeof arenaMain>) =>
  arenaMain(argv, io, env, { profilesDir: "off", ...o });

const LONG = 120_000;
const RULESET = "perfidia-1@1.1.0";
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A seat of a synthetic run. */
interface SynthSeat {
  readonly seat: PlayerId;
  readonly provider: string;
  readonly model: string;
  readonly endpoint?: string;
  readonly promptVariant: PromptVariant;
  /** Default medium; the presets send GLM's listed `low` (review: the label is the level sent). */
  readonly effort?: "low" | "medium";
}

/** One attempt's usage: prompt split into input, cache writes and reads; output. */
interface Usage {
  readonly input: number;
  readonly write: number;
  readonly read: number;
  readonly output: number;
}

/** A wake: its game time and its attempts. */
interface SynthWake {
  readonly t: number;
  readonly rounds: readonly Usage[];
}

/** The budget-mix seats as their providers receive them (channel per provider). */
const BUDGET_MIX: readonly SynthSeat[] = [
  { seat: "p1", provider: "anthropic", model: "claude-haiku-5-5", promptVariant: "system" },
  { seat: "p2", provider: "openai", model: "gpt-6-luna", promptVariant: "developer" },
  { seat: "p3", provider: "google", model: "gemini-3.8-flash", promptVariant: "envelope" },
  {
    seat: "p4",
    provider: "openrouter",
    model: "z-ai/glm-5.3-flash",
    endpoint: "z-ai/fp8",
    promptVariant: "envelope",
    effort: "low",
  },
];

function callLine(
  s: SynthSeat,
  turn: number,
  round: number,
  t: number,
  u: Usage,
  o: { readonly cost?: number } = {},
): LlmCallLine {
  return LlmCallLineSchema.parse({
    k: "llm_call",
    seat: s.seat,
    turn,
    round,
    attempt: 1,
    kind: "round",
    t,
    latencyMs: 1000,
    ttftMs: null,
    provider: s.provider,
    model: s.model,
    servedBy: s.model,
    effort: s.effort ?? "medium",
    maxTokens: 32768,
    stop: "tool_use",
    rawStop: "tool_use",
    refusal: null,
    fallback: false,
    cacheMiss: false,
    usage: [
      {
        model: s.model,
        kind: "message",
        input: u.input,
        cacheWrite5m: u.write,
        cacheWrite1h: 0,
        cacheRead: u.read,
        output: u.output,
        estimated: false,
      },
    ],
    costNanoUsd: o.cost ?? 1,
    seatSpentNanoUsd: 1,
    capNanoUsd: 5_000_000_000,
    wakeSpentNanoUsd: 1,
    unpriced: [],
    calls: 1,
    textChars: 0,
    reasoningChars: 0,
    requestId: null,
    error: null,
    ...(s.endpoint === undefined ? {} : { endpoint: s.endpoint }),
  });
}

function seatsFile(seats: readonly SynthSeat[], fake: boolean): SeatsFile {
  return SeatsFileSchema.parse({
    harness: "orchestrator/1",
    promptVersion: PROMPT_VERSION,
    prompts: { shared: "s", operator: "o", tools: "t" },
    seats: seats.map((s, i) => ({
      seat: s.seat,
      kind: "llm",
      label: `llm:${fake ? "fake" : s.provider}/x/${s.effort ?? "medium"}:p@1:p2`,
      provider: fake ? "fake" : s.provider,
      model: s.model,
      effort: s.effort ?? "medium",
      maxTokens: 32768,
      capNanoUsd: 5_000_000_000,
      profile: PROFILES[i % PROFILES.length],
      handoffBot: "bot:turtle@3",
      prompt: "h",
      ...(s.endpoint === undefined ? {} : { endpoint: s.endpoint }),
      promptVariant: s.promptVariant,
      reminders: "last-round",
      ...(fake
        ? {
            intended: { provider: s.provider, model: s.model, endpoint: s.endpoint ?? null },
          }
        : {}),
    })),
  });
}

/** A minimal valid `arena.json` (`perfidia-arena/2`): what calibration reads is in `o`. */
function report(o: {
  readonly status: "ended" | "stopped" | "aborted";
  readonly fake: boolean;
  readonly lastT: number;
  readonly seed: number;
  readonly clock?: string;
  readonly levelE?: boolean;
}): ArenaReport {
  const zero = { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 };
  return ArenaReportSchema.parse({
    format: "perfidia-arena/2",
    status: o.status,
    reason: null,
    fake: o.fake,
    ruleset: RULESET,
    seed: o.seed,
    players: 6,
    days: 7,
    clock: o.clock ?? "lockstep",
    promptVersion: PROMPT_VERSION,
    harness: "orchestrator/1",
    lastT: o.lastT,
    endedAt: o.status === "ended" ? o.lastT : null,
    result: null,
    seats: [],
    bots: [],
    totals: {
      costNanoUsd: 0,
      attempts: 0,
      tokens: zero,
      cacheReadPct: 0,
      fallbackPermille: 0,
      preflightNanoUsd: 0,
    },
    estimate: { low: 0, central: 0, high: 0 },
    projection: { fromDays: 0, toDays: 7, costNanoUsd: 0 },
    recommendedSpeed: null,
    pauses: [],
    alerts: [],
    daily: [],
    llmToBotWarCalls: 0,
    levelE: { ok: o.levelE ?? true, actions: 1, checkpoints: 1, divergence: null },
    exit: {
      alliancesFormed: 0,
      betrayals: 0,
      met: false,
      llm: { alliances: 0, asBetrayer: 0, asVictim: 0, betrayals: 0, met: false },
      events: [],
    },
    budget: {
      budgetNanoUsd: null,
      reserveNanoUsd: 0,
      killAtNanoUsd: null,
      carryNanoUsd: 0,
      onBudget: "handoff",
      estimate: null,
      actualNanoUsd: 0,
      attemptsNanoUsd: 0,
      preflightNanoUsd: 0,
      probeNanoUsd: 0,
      estimatedNanoUsd: 0,
      feesNanoUsd: 0,
      under: null,
      withinPrediction: null,
      killSwitch: null,
      wall: { start: null, end: null },
      byProvider: [],
    },
    exit4: {
      models: 0,
      ended: o.status === "ended",
      estimateStored: false,
      noHandoff: true,
      withinPrediction: false,
      under: false,
      levelE: o.levelE ?? true,
      reconciled: null,
      met: false,
    },
  });
}

/** A deterministic integer stream (tests only). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s;
  };
}

/**
 * Wakes of one seat over `days` game days: `perDay` wakes a day, each of `rounds` attempts, the
 * prompt growing by each reply and its results, the stable prefix read from the cache.
 */
function wakesOf(seed: number, days: number, perDay: number, rounds = 4): SynthWake[] {
  const r = lcg(seed);
  const out: SynthWake[] = [];
  for (let d = 0; d < days; d += 1) {
    for (let w = 0; w < perDay; w += 1) {
      const t = d * DAY + Math.floor((w * DAY) / perDay) + 60;
      const usage: Usage[] = [];
      let prompt = 9_000 + (r() % 3_000);
      for (let k = 0; k < rounds; k += 1) {
        const output = 400 + (r() % 1_600);
        const read = k === 0 ? 8_000 : prompt - 2_000;
        usage.push({ input: 100, write: prompt - read - 100, read, output });
        prompt += output + 1_500;
      }
      out.push({ t, rounds: usage });
    }
  }
  return out;
}

/** Writes a synthetic run directory; `wakes` per seat. */
function writeRun(
  dir: string,
  o: {
    readonly seats: readonly SynthSeat[];
    readonly wakes: ReadonlyMap<PlayerId, readonly SynthWake[]>;
    readonly status?: "ended" | "stopped" | "aborted";
    readonly lastT: number;
    readonly fake?: boolean;
    readonly seed?: number;
    readonly clock?: string;
    readonly handoffs?: ReadonlyMap<PlayerId, number>;
    readonly transcripts?: boolean;
    readonly briefingBytes?: (day: number) => number;
  },
): string {
  mkdirSync(dir, { recursive: true });
  const fake = o.fake ?? false;
  writeFileSync(
    join(dir, "arena.json"),
    `${JSON.stringify(
      report({
        status: o.status ?? "stopped",
        fake,
        lastT: o.lastT,
        seed: o.seed ?? 1,
        ...(o.clock === undefined ? {} : { clock: o.clock }),
      }),
    )}\n`,
  );
  writeFileSync(join(dir, "seats.json"), `${JSON.stringify(seatsFile(o.seats, fake))}\n`);
  const rows: string[] = [];
  for (const s of o.seats) {
    for (const [i, w] of (o.wakes.get(s.seat) ?? []).entries()) {
      const turn = i + 1;
      for (const [k, u] of w.rounds.entries())
        rows.push(JSON.stringify(callLine(s, turn, k, w.t, u)));
      if (o.transcripts === true) {
        const tdir = join(dir, "transcripts", s.seat);
        mkdirSync(tdir, { recursive: true });
        const bytes = o.briefingBytes?.(Math.floor(w.t / DAY)) ?? 1_000;
        const request = {
          k: "request",
          seat: s.seat,
          turn,
          round: 0,
          attempt: 1,
          kind: "round",
          prefix: { shared: "a", seat: "b", tools: "c" },
          from: 0,
          entries: [{ role: "user", parts: [{ kind: "text", text: "x".repeat(bytes) }] }],
        };
        writeFileSync(join(tdir, `t${turn}.jsonl`), `${JSON.stringify(request)}\n`);
      }
    }
  }
  for (const [seat, t] of o.handoffs ?? []) {
    rows.push(
      JSON.stringify({
        k: "handoff",
        seat,
        t,
        reason: "cap",
        label: "bot:turtle@3",
        spentNanoUsd: 0,
        capNanoUsd: 0,
      }),
    );
  }
  writeFileSync(join(dir, "llm_calls.jsonl"), rows.map((r) => `${r}\n`).join(""));
  return dir;
}

/** A fresh base directory for synthetic runs and profiles. */
function base(): string {
  const d = runDir("synthetic");
  mkdirSync(d, { recursive: true });
  return d;
}

const one = (seats: readonly SynthSeat[], days: number, perDay: number, seed = 1) =>
  new Map(seats.map((s, i) => [s.seat, wakesOf(seed * 100 + i, days, perDay)]));

/** The prediction options of a 7-day lockstep plan priced at one pinned instant. */
const OPTS: PredictOptions = {
  days: 7,
  clock: "lockstep",
  cacheTtl: "5m",
  maxTokens: 32768,
  promptCapTokens: 160_000,
  priceAt: "2026-10-20T00:00:00.000Z",
  reminders: "last-round",
  ruleset: RULESET,
  wallMsPerGameDay: 0,
};

const predictSeat = (s: SynthSeat): PredictSeat => ({
  seat: s.seat,
  provider: s.provider,
  model: s.model,
  endpoint: s.endpoint ?? null,
  effort: s.effort ?? "medium",
  fallbacks: "off",
  profile: "odysseus@1",
  sampleTokens: 12_000,
  promptVariant: s.promptVariant,
});

/** What one line's usage costs at `ctx` (the ledger's own pricing): the re-priced spend. */
const linesNano = (wakes: readonly SynthWake[], s: SynthSeat, ctx: PriceContext): number =>
  wakes.reduce(
    (n, w) =>
      n +
      w.rounds.reduce(
        (m, u, k) =>
          m +
          costOf(
            callLine(s, 1, k, w.t, u).usage.map((x) => ({
              model: x.model,
              kind: x.kind,
              tokens: x,
              estimated: x.estimated,
            })),
            ctx,
          ).nanoUsd,
        0,
      ),
    0,
  );

describe("arena calibrate (design §5.3)", () => {
  test("seat-days per key: complete days only, none from a hand-off on; fake runs give growth only", () => {
    const b = base();
    const seats = BUDGET_MIX;
    // Lines on three game days, but the log stops an hour into the third: two complete days.
    const wakes = one(seats, 3, 6);
    const real = writeRun(join(b, "cal-a"), {
      seats,
      wakes,
      lastT: 2 * DAY + 3_600,
      handoffs: new Map([["p2", DAY + 100]]),
    });
    // A 7-day fake run: briefing growth from its transcripts only.
    const fake = writeRun(join(b, "growth"), {
      seats,
      wakes: one(seats, 7, 2, 9),
      lastT: 7 * DAY,
      status: "ended",
      fake: true,
      transcripts: true,
      briefingBytes: (d) => 1_500 + 450 * d,
    });
    const profiles = join(b, "profiles");
    const r = calibrate([real, fake], { profilesDir: profiles });
    expect(r.skipped).toEqual([]);
    expect(r.profiles.map((p) => p.profile.key.model)).toEqual([
      "claude-haiku-5-5",
      "gemini-3.8-flash",
      "gpt-6-luna",
      "z-ai/glm-5.3-flash",
    ]);
    const byModel = new Map(r.profiles.map((p) => [p.profile.key.model, p.profile]));
    const haiku = byModel.get("claude-haiku-5-5");
    expect(haiku?.key).toEqual({
      provider: "anthropic",
      model: "claude-haiku-5-5",
      endpoint: null,
      effort: "medium",
      promptVariant: "system",
      reminders: "last-round",
      maxTokens: 32768,
      promptVersion: PROMPT_VERSION,
      rulesetMajor: "perfidia-1@1",
    });
    // Days 0 and 1 (lastT is inside day 2): 2 seat-days of 6 wakes of 4 attempts each.
    expect(haiku?.seatDays.map((d) => [d.seat, d.day, d.wakes.length])).toEqual([
      ["p1", 0, 6],
      ["p1", 1, 6],
    ]);
    const round = haiku?.seatDays[0]?.wakes[0]?.rounds[0];
    const u = wakes.get("p1")?.[0]?.rounds[0];
    expect(round).toEqual({
      promptTokens: (u?.input ?? 0) + (u?.write ?? 0) + (u?.read ?? 0),
      outputTokens: u?.output ?? -1,
      cacheReadTokens: u?.read ?? -1,
      cacheWriteTokens: u?.write ?? -1,
    });
    // p2 was handed off during day 1: only day 0 is measured.
    expect(byModel.get("gpt-6-luna")?.seatDays.map((d) => d.day)).toEqual([0]);
    expect(byModel.get("z-ai/glm-5.3-flash")?.key.endpoint).toBe("z-ai/fp8");
    // The fake run: no seat-day anywhere, its growth in every profile of perfidia-1@1.
    for (const p of r.profiles) {
      expect(p.profile.runs).toEqual([{ run: "cal-a", seed: 1 }]);
      expect(p.profile.briefingGrowth).toEqual(
        Array.from({ length: 7 }, (_, d) => ({
          day: d,
          briefingTokens: Math.ceil((1_500 + 450 * d) / BRIEFING_BYTES_PER_TOKEN),
        })),
      );
    }
    expect(r.growth.map((g) => [g.rulesetMajor, g.runs])).toEqual([["perfidia-1@1", ["growth"]]]);
    // The files: one per key, valid, named by the key.
    const files = readdirSync(profiles).toSorted(byName);
    expect(files).toEqual(r.profiles.map((p) => profileFileName(p.profile.key)).toSorted(byName));
    for (const f of files) {
      TokenProfileSchema.parse(JSON.parse(readFileSync(join(profiles, f), "utf8")));
    }
    expect(loadProfiles(profiles).map((p) => profileKeyText(p.profile.key))).toEqual(
      r.profiles.map((p) => profileKeyText(p.profile.key)),
    );
  });

  test("profiles accumulate; a run measured again replaces its seat-days; refusals", () => {
    const b = base();
    const seats = BUDGET_MIX.slice(0, 1);
    const profiles = join(b, "profiles");
    const a = writeRun(join(b, "a"), { seats, wakes: one(seats, 1, 5), lastT: DAY, seed: 4 });
    const c = writeRun(join(b, "c"), {
      seats,
      wakes: one(seats, 2, 3, 2),
      lastT: 2 * DAY,
      seed: 5,
    });
    calibrate([a], { profilesDir: profiles });
    const r1 = calibrate([c], { profilesDir: profiles });
    expect(r1.profiles[0]?.profile.runs).toEqual([
      { run: "a", seed: 4 },
      { run: "c", seed: 5 },
    ]);
    expect(r1.profiles[0]?.profile.seatDays.map((d) => [d.run, d.day])).toEqual([
      ["a", 0],
      ["c", 0],
      ["c", 1],
    ]);
    const r2 = calibrate([a], { profilesDir: profiles });
    expect(r2.profiles[0]?.profile.seatDays.length).toBe(3);
    expect(r2.profiles[0]?.measured).toBe(1);
    // No briefing growth measured: a warning says what a calibrated prediction then assumes.
    expect(r2.warnings.join("\n")).toContain("no briefing growth");

    const fakeShort = writeRun(join(b, "f2"), {
      seats,
      wakes: one(seats, 2, 2),
      lastT: 2 * DAY,
      status: "ended",
      fake: true,
      transcripts: true,
    });
    const rt = writeRun(join(b, "rt"), {
      seats,
      wakes: one(seats, 1, 2),
      lastT: DAY,
      clock: "realtime",
    });
    const aborted = writeRun(join(b, "ab"), {
      seats,
      wakes: one(seats, 1, 2),
      lastT: DAY,
      status: "aborted",
    });
    const refused = (dirs: string[]): string => {
      try {
        calibrate(dirs, { profilesDir: join(b, "none") });
      } catch (e) {
        expect(e).toBeInstanceOf(UsageError);
        return e instanceof Error ? e.message : "";
      }
      return "calibrated";
    };
    const msg = refused([fakeShort, rt, aborted]);
    expect(msg).toContain("nothing to calibrate");
    expect(msg).toContain(
      "f2: a --fake run gives only the briefing growth, from at least 7 complete game days; it played 2",
    );
    expect(msg).toContain("rt: its clock is realtime");
    expect(msg).toContain("ab: its status is aborted");
    expect(existsSync(join(b, "none"))).toBe(false);
    mkdirSync(join(b, "x"), { recursive: true });
    const twin = writeRun(join(b, "x", "a"), { seats, wakes: one(seats, 1, 2), lastT: DAY });
    expect(refused([a, twin])).toContain("share the name a");
    // Two files of one key are refused when profiles load.
    writeFileSync(join(profiles, "copy.json"), readFileSync(r2.profiles[0]?.path ?? "", "utf8"));
    expect(() => profilesFor(profiles)).toThrow("hold the same key");
    expect(() => profilesFor(join(b, "missing"))).toThrow("no such directory");
    expect(profilesFor("off")).toEqual([]);
    expect(rulesetMajorOf("perfidia-1@1.1.0")).toBe("perfidia-1@1");
  });
});

/** A profile of `seatDays` seat-days built directly (each day's seat-days with the same wakes). */
function profileOf(
  s: SynthSeat,
  days: readonly { readonly day: number; readonly wakes: readonly SynthWake[] }[],
  growth: TokenProfile["briefingGrowth"] = [],
): TokenProfile {
  return TokenProfileSchema.parse({
    format: "perfidia-profile/1",
    key: {
      provider: s.provider,
      model: s.model,
      endpoint: s.endpoint ?? null,
      effort: s.effort ?? "medium",
      promptVariant: s.promptVariant,
      reminders: "last-round",
      maxTokens: 32768,
      promptVersion: PROMPT_VERSION,
      rulesetMajor: "perfidia-1@1",
    },
    // One run per seat-day: independent seat-days (a calibrated profile needs 3 of them).
    runs: days.map((_d, i) => ({ run: `r${i}`, seed: i + 1 })),
    seatDays: days.map((d, i) => ({
      run: `r${i}`,
      seat: `p${i + 1}`,
      day: d.day,
      wakes: d.wakes.map((w) => ({
        rounds: w.rounds.map((u) => ({
          promptTokens: u.input + u.write + u.read,
          outputTokens: u.output,
          cacheReadTokens: u.read,
          cacheWriteTokens: u.write,
        })),
      })),
    })),
    briefingGrowth: growth,
  });
}

describe("measured-point (1–2 seat-days)", () => {
  test("central is phase 2's projectSpend (+15%) of the re-priced measured spend; no percentiles", () => {
    const luna = BUDGET_MIX[1];
    if (luna === undefined) throw new Error("no seat");
    const w0 = wakesOf(7, 1, 14);
    const ctx = { provider: "openai", endpoint: null, at: OPTS.priceAt ?? "" };
    const spend = linesNano(w0, luna, ctx);
    const scenario = estimateCard(scenarioCard(luna.model, ctx), 7, "lockstep", "5m", "medium");
    const p = predict([predictSeat(luna)], {
      ...OPTS,
      profiles: [profileOf(luna, [{ day: 0, wakes: w0 }])],
    });
    const seat = p.seats[0];
    expect(seat?.source).toBe("measured-point");
    expect(seat?.central).toBe(projectSpend(spend, 1, 7));
    // projectSpend: × the bots' wake weight of 7 days over day 1's, + 15%.
    const w7 = BOT_DAY_PROFILE.reduce((a, b) => a + b, 0);
    expect(
      Math.abs((seat?.central ?? 0) - (spend * w7 * 1.15) / (BOT_DAY_PROFILE[0] ?? 1)),
    ).toBeLessThan(1);
    const ratio = (num: number): number =>
      Number(
        (BigInt(seat?.central ?? 0) * BigInt(num) * 2n + BigInt(scenario.central)) /
          (2n * BigInt(scenario.central)),
      );
    expect(seat?.low).toBe(ratio(scenario.low));
    expect(seat?.high).toBe(ratio(scenario.high));
    expect(seat?.low).toBeLessThan(seat?.central ?? 0);
    expect(p.match).toEqual({
      low: seat?.low ?? -1,
      central: seat?.central ?? -1,
      high: seat?.high ?? -1,
      source: "measured-point",
    });
    expect(p.assumptions.join("\n")).toContain("no percentiles");
    expect(p.assumptions.join("\n")).not.toContain("p10");

    // Two seat-days of one seat (days 1 and 2): the projection of their sum over 2 days.
    const w1 = wakesOf(8, 1, 11).map((w) => ({ t: w.t + DAY, rounds: w.rounds }));
    const two = predict([predictSeat(luna)], {
      ...OPTS,
      profiles: [
        profileOf(luna, [
          { day: 0, wakes: w0 },
          { day: 1, wakes: w1 },
        ]),
      ],
    });
    expect(two.seats[0]?.source).toBe("measured-point");
    expect(two.seats[0]?.central).toBe(projectSpend(spend + linesNano(w1, luna, ctx), 2, 7));
  });
});

describe("calibrated (≥ 3 seat-days): the seeded bootstrap", () => {
  const haiku = BUDGET_MIX[0];
  if (haiku === undefined) throw new Error("no seat");
  const ctx = { provider: "anthropic", endpoint: null, at: OPTS.priceAt ?? "" };

  test("deterministic: same seed, same figures; another seed, other figures", () => {
    const days = [0, 0, 0, 1].map((day, i) => ({
      day,
      wakes: wakesOf(30 + i, 1, 10 + i).map((w) => ({ t: w.t + day * DAY, rounds: w.rounds })),
    }));
    const profile = profileOf(haiku, days, [
      { day: 0, briefingTokens: 500 },
      { day: 6, briefingTokens: 1_500 },
    ]);
    const run = (seed?: number) =>
      predict([predictSeat(haiku), { ...predictSeat(haiku), seat: "p2" }], {
        ...OPTS,
        profiles: [profile],
        ...(seed === undefined ? {} : { bootstrapSeed: seed }),
      });
    const a = run();
    const b = run();
    expect(b).toEqual(a);
    expect(a.seats.map((s) => s.source)).toEqual(["calibrated", "calibrated"]);
    expect(a.match.source).toBe("calibrated");
    for (const s of a.seats) {
      expect(s.low).toBeLessThanOrEqual(s.central);
      expect(s.central).toBeLessThanOrEqual(s.high);
    }
    // Two seats, independent streams: different draws, and the match is the bootstrap of the sum
    // (between the sum of the p10s and the sum of the p90s, not their sum).
    expect(a.seats[0]?.central).not.toBe(a.seats[1]?.central);
    const lows = a.seats.reduce((n, s) => n + s.low, 0);
    const highs = a.seats.reduce((n, s) => n + s.high, 0);
    expect(a.match.low).toBeGreaterThan(lows);
    expect(a.match.high).toBeLessThan(highs);
    expect(run(7)).not.toEqual(a);
    expect(run(7)).toEqual(run(7));
    expect(formatEstimate(EstimateFileSchema.parse(estimateOf(a)))).toContain(
      "match (calibrated, p10 / p50 / p90 of the bootstrap of the sum)",
    );
    expect(a.assumptions.join("\n")).toContain(`${BOOTSTRAP_REPLICATES} replicates`);
  });

  test("exact on a degenerate profile: counts scaled by BOT_DAY_PROFILE, prompts grown by the briefing growth", () => {
    // Three seat-days of day 0, each 10 identical wakes: every replicate is the same.
    const wake: SynthWake = { t: 60, rounds: wakesOf(5, 1, 1)[0]?.rounds ?? [] };
    const wakes = Array.from({ length: 10 }, () => wake);
    const days = [0, 0, 0].map((day) => ({ day, wakes }));
    const wakeNano = linesNano([wake], haiku, ctx);
    const flat = predict([predictSeat(haiku)], {
      ...OPTS,
      days: 3,
      profiles: [profileOf(haiku, days)],
    });
    const n1 = Math.round((10 * (BOT_DAY_PROFILE[1] ?? 0)) / (BOT_DAY_PROFILE[0] ?? 1));
    const n2 = Math.round((10 * (BOT_DAY_PROFILE[2] ?? 0)) / (BOT_DAY_PROFILE[0] ?? 1));
    const expected = (10 + n1 + n2) * wakeNano;
    expect(flat.seats[0]).toMatchObject({
      source: "calibrated",
      low: expected,
      central: expected,
      high: expected,
    });
    // With growth: day 2's and day 3's wakes carry their extra briefing tokens in every attempt.
    const growth = [
      { day: 0, briefingTokens: 500 },
      { day: 1, briefingTokens: 800 },
      { day: 2, briefingTokens: 1_100 },
    ];
    const grown = predict([predictSeat(haiku)], {
      ...OPTS,
      days: 3,
      profiles: [profileOf(haiku, days, growth)],
    });
    const grownWake = (delta: number): number =>
      wake.rounds.reduce((n, u, k) => {
        const prompt = u.input + u.write + u.read + delta;
        const read = k === 0 ? u.read : u.read + Math.round((delta * u.read) / (prompt - delta));
        const uncached = prompt - read;
        const write = Math.round((uncached * u.write) / (u.input + u.write));
        return (
          n +
          costOf(
            [
              {
                model: haiku.model,
                kind: "message",
                tokens: {
                  input: uncached - write,
                  cacheWrite5m: write,
                  cacheWrite1h: 0,
                  cacheRead: read,
                  output: u.output,
                },
                estimated: false,
              },
            ],
            ctx,
          ).nanoUsd
        );
      }, 0);
    expect(grown.seats[0]?.central).toBe(10 * wakeNano + n1 * grownWake(300) + n2 * grownWake(600));
    expect(grown.seats[0]?.central).toBeGreaterThan(flat.seats[0]?.central ?? 0);
    // A fractional last day plays its share of the wakes.
    const half = predict([predictSeat(haiku)], {
      ...OPTS,
      days: 1.5,
      profiles: [profileOf(haiku, days)],
    });
    expect(half.seats[0]?.central).toBe((10 + Math.round(n1 * 0.5)) * wakeNano);
  });

  test("priced at the cards of the planned wall times (Gemini 4 Argon's change)", () => {
    const argon: SynthSeat = {
      seat: "p1",
      provider: "google",
      model: "gemini-4-argon",
      promptVariant: "envelope",
    };
    const days = [0, 0, 0].map((day, i) => ({ day, wakes: wakesOf(60 + i, 1, 6) }));
    const profile = profileOf(argon, days);
    const o = { ...OPTS, days: 2, profiles: [profile] };
    // Pinned at a date before the change: the introductory card throughout.
    const pinned = predict([predictSeat(argon)], { ...o, priceAt: "2026-11-29T22:00:00.000Z" });
    // Planned wall times from 22:00 on November 29: day 1 reaches 00:00 on November 30 (the dearer
    // card, which doubles every price), and day 2 is wholly after it.
    const walled = predict([predictSeat(argon)], {
      ...o,
      priceAt: "2026-11-29T22:00:00.000Z",
      wallMsPerGameDay: LOCKSTEP_WALL_MS_PER_GAME_DAY,
    });
    const ratio = (walled.seats[0]?.central ?? 0) / (pinned.seats[0]?.central ?? 1);
    expect(ratio).toBeGreaterThan(1.999);
    expect(ratio).toBeLessThan(2.001);
    expect(walled.assumptions.join("\n")).toContain("planned wall-clock time");
    expect(plannedWallMsPerGameDay({ kind: "lockstep" }, null)).toBe(LOCKSTEP_WALL_MS_PER_GAME_DAY);
    expect(plannedWallMsPerGameDay({ kind: "lockstep" }, "2026-10-20T00:00:00.000Z")).toBe(0);
    expect(plannedWallMsPerGameDay({ kind: "realtime", speed: { num: 3, den: 1 } }, null)).toBe(
      28_800_000,
    );
  });

  test("the match: a bootstrap only when every seat is calibrated, else the sum of the seat bounds", () => {
    const luna = BUDGET_MIX[1];
    if (luna === undefined) throw new Error("no seat");
    const days3 = [0, 0, 0].map((day, i) => ({ day, wakes: wakesOf(70 + i, 1, 8) }));
    const mixed = predict([predictSeat(haiku), predictSeat(luna)], {
      ...OPTS,
      profiles: [profileOf(haiku, days3), profileOf(luna, days3.slice(0, 1))],
    });
    expect(mixed.seats.map((s) => s.source)).toEqual(["calibrated", "measured-point"]);
    expect(mixed.match.source).toBe("measured-point");
    expect(mixed.match.central).toBe(mixed.seats.reduce((n, s) => n + s.central, 0));
    const withScenario = predict([predictSeat(haiku), predictSeat(luna)], {
      ...OPTS,
      profiles: [profileOf(haiku, days3)],
    });
    expect(withScenario.match.source).toBe("scenario");
    expect(withScenario.assumptions.join("\n")).toContain("source scenario");
    expect(withScenario.assumptions.join("\n")).toContain("source calibrated (p1)");
    // No profile, or a real-time plan: the scenario, its assumptions word for word.
    const none = predict([predictSeat(haiku)], OPTS);
    expect(none.assumptions).toEqual(scenarioAssumptions());
    const rt = predict([predictSeat(haiku)], {
      ...OPTS,
      clock: "realtime",
      profiles: [profileOf(haiku, days3)],
    });
    expect(rt.seats[0]?.source).toBe("scenario");
    expect(rt.assumptions.join("\n")).toContain("real-time plan keeps the scenario for p1");
    // A key that differs in one part (the cadence) does not match.
    const other = predict([predictSeat(haiku)], {
      ...OPTS,
      reminders: "every-round",
      profiles: [profileOf(haiku, days3)],
    });
    expect(other.seats[0]?.source).toBe("scenario");
  });
});

/** An `estimate.json` of a prediction (no lineup, no budget). */
function estimateOf(p: ReturnType<typeof predict>) {
  return {
    format: "perfidia-estimate/1",
    lineup: null,
    ruleset: RULESET,
    players: 6,
    matchDays: p.days,
    days: p.days,
    clock: "lockstep",
    cacheTtl: "5m",
    maxTokens: 32768,
    promptCapTokens: 160_000,
    seats: p.seats.map((s) => ({
      seat: s.seat,
      provider: s.provider,
      model: s.model,
      effort: s.effort,
      fallbacks: s.fallbacks,
      profile: s.profile,
      capNanoUsd: 0,
      wakeCapNanoUsd: null,
      low: s.low,
      central: s.central,
      high: s.high,
      source: s.source,
      priceCards: [...s.priceCards],
      attemptBoundNanoUsd: s.attemptBoundNanoUsd,
    })),
    match: p.match,
    reserve: p.reserve,
    budget: null,
    assumptions: [...p.assumptions],
  };
}

async function cli(argv: readonly string[]) {
  const io = memoryIo();
  const code = await main(argv, io, {});
  return { code, out: io.stdout(), err: io.stderr() };
}

describe("the source label in estimate.json and arena.json (arena calibrate, run --fake --profiles)", () => {
  xtest(
    "calibrated budget-mix: estimate and run; one seat-day each: measured-point",
    async () => {
      const b = base();
      // A synthetic 3-day calibration of budget-mix (stopped after day 3) and a 7-day fake run.
      const cal = writeRun(join(b, "budget-mix-cal"), {
        seats: BUDGET_MIX,
        wakes: one(BUDGET_MIX, 3, 12),
        lastT: 3 * DAY,
      });
      const growth = writeRun(join(b, "growth"), {
        seats: BUDGET_MIX,
        wakes: one(BUDGET_MIX, 7, 2, 3),
        lastT: 7 * DAY,
        status: "ended",
        fake: true,
        transcripts: true,
        briefingBytes: (d) => 1_500 + 450 * d,
      });
      const profiles = join(b, "profiles");
      const c = await cli(["calibrate", cal, growth, "--profiles", profiles]);
      expect(c.code).toBe(0);
      expect(c.out).toContain("source calibrated");
      expect(c.out.match(/^profile /gm)?.length).toBe(4);

      const est = await cli([
        "estimate",
        "--lineup",
        "budget-mix",
        "--price-date",
        "2026-10-20",
        "--profiles",
        profiles,
      ]);
      expect(est.code).toBe(0);
      expect(est.out).toContain("match (calibrated, p10 / p50 / p90 of the bootstrap of the sum)");
      // A calibrated seat is announced, and its default cap never falls below the scenario's.
      expect(est.out).toContain(
        "warning: p1, p2, p3, p4: predicted from a calibrated profile (a bootstrap of measured wakes)",
      );
      const planned = planArena(
        {
          fake: true,
          seed: 1,
          idKey: "seed",
          priceDate: "2026-10-20",
          lineup: "budget-mix",
          profiles,
        },
        arenaEnv({}),
      );
      for (const seat of planned.seats) {
        if (seat.kind !== "llm") continue;
        const pred = planned.prediction.seats.find((x) => x.seat === seat.seat);
        expect(pred?.source).toBe("calibrated");
        expect(seat.capNanoUsd).toBe(
          defaultSeatCap(Math.max(pred?.high ?? 0, pred?.scenarioHigh ?? 0)),
        );
        expect(seat.capNanoUsd).toBeGreaterThanOrEqual(defaultSeatCap(pred?.scenarioHigh ?? 0));
      }
      // Here the calibrated p90s are under the scenario's highs: the floor is what applies.
      expect(planned.prediction.seats.every((x) => x.scenarioHigh > x.high)).toBe(true);
      expect(est.out.match(/ calibrated$/gm)?.length).toBe(4);
      const again = await cli([
        "estimate",
        "--lineup",
        "budget-mix",
        "--price-date",
        "2026-10-20",
        "--profiles",
        profiles,
      ]);
      expect(again.out).toBe(est.out);
      // The default directory (no --profiles) is `MainOptions.profilesDir`: the tests' `off` keeps
      // the scenario, whatever an owner calibrates into packages/orchestrator/profiles/ (review).
      const byDefault = memoryIo();
      expect(
        await arenaMain(
          ["estimate", "--lineup", "budget-mix", "--price-date", "2026-10-20"],
          byDefault,
          {},
          { profilesDir: profiles },
        ),
      ).toBe(0);
      expect(byDefault.stdout()).toBe(est.out);
      const testDefault = await cli([
        "estimate",
        "--lineup",
        "budget-mix",
        "--price-date",
        "2026-10-20",
      ]);
      expect(testDefault.out).toContain("match (scenario, the sum of the seat bounds)");
      // --profiles off: the scenario.
      const off = await cli([
        "estimate",
        "--lineup",
        "budget-mix",
        "--price-date",
        "2026-10-20",
        "--profiles",
        "off",
      ]);
      expect(off.out).toContain("match (scenario, the sum of the seat bounds)");

      const dir = join(b, "run");
      const run = await cli([
        "run",
        "--fake",
        "--lineup",
        "budget-mix",
        "--days",
        "2",
        "--seed",
        "1",
        "--id-key",
        "seed",
        "--price-date",
        "2026-10-20",
        "--profiles",
        profiles,
        "--quiet",
        "--out",
        dir,
      ]);
      expect(run.code).toBe(0);
      const e = EstimateFileSchema.parse(
        JSON.parse(readFileSync(join(dir, "estimate.json"), "utf8")),
      );
      expect(e.seats.map((s) => s.source)).toEqual([
        "calibrated",
        "calibrated",
        "calibrated",
        "calibrated",
      ]);
      expect(e.match.source).toBe("calibrated");
      const a = ArenaReportSchema.parse(JSON.parse(readFileSync(join(dir, "arena.json"), "utf8")));
      expect(a.budget.estimate?.source).toBe("calibrated");
      expect(a.levelE?.ok).toBe(true);
      expect(a.budget.estimate?.central).toBe(e.match.central);

      // One seat-day per key: measured-point everywhere, in both files.
      const short = writeRun(join(b, "budget-mix-1d"), {
        seats: BUDGET_MIX,
        wakes: one(BUDGET_MIX, 1, 12),
        lastT: DAY,
      });
      const p1 = join(b, "profiles-1d");
      expect((await cli(["calibrate", short, "--profiles", p1])).code).toBe(0);
      const dir1 = join(b, "run-1d");
      const run1 = await cli([
        "run",
        "--fake",
        "--lineup",
        "budget-mix",
        "--days",
        "1",
        "--seed",
        "1",
        "--id-key",
        "seed",
        "--price-date",
        "2026-10-20",
        "--profiles",
        p1,
        "--quiet",
        "--out",
        dir1,
      ]);
      expect(run1.code).toBe(0);
      const e1 = EstimateFileSchema.parse(
        JSON.parse(readFileSync(join(dir1, "estimate.json"), "utf8")),
      );
      expect(e1.match.source).toBe("measured-point");
      expect(new Set(e1.seats.map((s) => s.source))).toEqual(new Set(["measured-point"]));
      // Below 3 seat-days no percentile is printed or stored.
      expect(formatEstimate(e1)).not.toMatch(/p10|p50|p90/);
      expect(formatEstimate(e1)).toContain("match (measured-point, the sum of the seat bounds)");
      const a1 = ArenaReportSchema.parse(
        JSON.parse(readFileSync(join(dir1, "arena.json"), "utf8")),
      );
      expect(a1.budget.estimate?.source).toBe("measured-point");
    },
    LONG,
  );
});

/** One measured-point card group's share: its spend × the days' weight over day 1's, +15%. */
const groupShare = (spend: number, weight: number): number =>
  Math.round((spend * weight * 115) / ((BOT_DAY_PROFILE[0] ?? 1) * 100));

describe("the review's pins on the prediction's statistics", () => {
  const haiku = BUDGET_MIX[0];
  const argon: SynthSeat = {
    seat: "p1",
    provider: "google",
    model: "gemini-4-argon",
    promptVariant: "envelope",
  };
  if (haiku === undefined) throw new Error("no seat");
  const ctx = { provider: "anthropic", endpoint: null, at: OPTS.priceAt ?? "" };

  test("the bootstrap's p10 / p50 / p90, per seat and for the match, on a profile with known spread", () => {
    // Twenty independent seat-days of day 0 with 1..20 identical wakes: a replicate of one day
    // costs n wakes, n uniform on 1..20, so p10 / p50 / p90 sit near 2, 10 and 18 wakes.
    const wake: SynthWake = { t: 60, rounds: wakesOf(5, 1, 1)[0]?.rounds ?? [] };
    const days = Array.from({ length: 20 }, (_v, i) => ({
      day: 0,
      wakes: Array.from({ length: i + 1 }, () => wake),
    }));
    const w = linesNano([wake], haiku, ctx);
    const p = predict([predictSeat(haiku), { ...predictSeat(haiku), seat: "p2" }], {
      ...OPTS,
      days: 1,
      profiles: [profileOf(haiku, days)],
    });
    const inWakes = (n: number): number => n / w;
    // Nearest-rank percentiles of the seeded draws (seed 20261019, one stream per seat).
    expect(p.seats.map((s) => [s.low, s.central, s.high].map(inWakes))).toEqual([
      [3, 10, 18],
      [3, 11, 19],
    ]);
    // The match is the bootstrap of the sum (not the sum of the seats' percentiles).
    expect([p.match.low, p.match.central, p.match.high].map(inWakes)).toEqual([10, 21, 32]);
    expect(p.match.source).toBe("calibrated");
  });

  test("seat-days count once per (run, game day): three seats of one match day are one", () => {
    const days = [0, 0, 0].map((day, i) => ({ day, wakes: wakesOf(40 + i, 1, 6) }));
    const separate = profileOf(haiku, days);
    // The same three seat-days, all from one run: one independent seat-day.
    const shared = TokenProfileSchema.parse({
      ...separate,
      runs: [{ run: "r", seed: 1 }],
      seatDays: separate.seatDays.map((d) => ({ ...d, run: "r" })),
    });
    expect([independentSeatDays(separate), sourceOfProfile(separate)]).toEqual([3, "calibrated"]);
    expect([independentSeatDays(shared), sourceOfProfile(shared)]).toEqual([1, "measured-point"]);
    const p = predict([predictSeat(haiku)], { ...OPTS, profiles: [shared] });
    expect(p.seats[0]?.source).toBe("measured-point");
  });

  test("measured-point across two card groups: the +15% margin on each group's share", () => {
    const w0 = wakesOf(9, 1, 12);
    // Day 1 wholly before Gemini 4 Argon's change, day 2's window (stretched ×2) across it.
    const start = Date.parse("2026-11-30T00:00:00Z") - 5 * 3_600_000;
    const priceAt = new Date(start).toISOString();
    const p = predict([predictSeat(argon)], {
      ...OPTS,
      days: 2,
      priceAt,
      wallMsPerGameDay: LOCKSTEP_WALL_MS_PER_GAME_DAY,
      profiles: [profileOf(argon, [{ day: 0, wakes: w0 }])],
    });
    const at = (iso: string): number =>
      linesNano(w0, argon, { provider: "google", endpoint: null, at: iso });
    const before = at(priceAt);
    const after = at("2026-11-30T00:00:00.000Z");
    expect(after).toBeGreaterThan(before);
    expect(p.seats[0]?.source).toBe("measured-point");
    expect(p.seats[0]?.central).toBe(
      groupShare(before, BOT_DAY_PROFILE[0] ?? 0) + groupShare(after, BOT_DAY_PROFILE[1] ?? 0),
    );
  });
});
