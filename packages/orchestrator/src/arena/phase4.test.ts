// Phase 4, Pass 1a (docs/phase4.md): the exit path on the Claude family, end to end, with no network.
// - `arena estimate --lineup claude-duo`: the prediction, the reserve and K, pinned; the design's
//   $3.69 / $12.59 / $45.68 reproduced at the design's Sonnet 5.5 card, phase 2's $83.29 kept.
// - A budget whose kill threshold falls below the predicted low: exit 3, the §4.2 message, nothing
//   written.
// - `arena run --fake --lineup claude-duo --days 2 --budget-usd 55`: Level E, `estimate.json`
//   written before turn 1 with its sha256 in `seats.json`, `exit4` computed, byte-identical runs.
// - A budget just above the refusal threshold fires the kill switch: every seat handed off
//   `match_budget`, the total under the budget, the match ends.
// - SIGINT once hands every LLM seat to its bot; twice aborts.
// - `--budget-carry`; a failed probe's spend is charged; probes stop once the seats are halted.
// - `arena reconcile`: `reconcile.json`, exit 4 outside tolerance.
// - A redirecting base URL never receives the key (the whole CLI).
// The 2-day byte-identical runs, the 4-day kill switch, --budget-carry, SIGINT once, the failed
// probe and `arena reconcile` on a run run in the slow suite (PERFIDIA_SLOW=1,
// docs/architecture.md §13.8: `bun run test:slow`, run by `bun run test:exit`).

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { verifyLog } from "@perfidia/engine";
import { sha256Hex } from "@perfidia/engine/core";
import { memoryIo, readLog } from "@perfidia/sim";
import {
  ArenaReportSchema,
  EstimateFileSchema,
  LineupSchema,
  ReconcileFileSchema,
  SeatsFileSchema,
  type LlmLogLine,
} from "../log/schema.ts";
import { ModelError } from "../model/adapter.ts";
import { FakeAdapter, type Brain } from "../model/fake.ts";
import { formatCents, requirePrice } from "../model/prices.ts";
import { botBrain } from "./brain.ts";
import { main as arenaMain, processSignalsOf } from "./cli.ts";
import { estimateSeat } from "./cost.ts";
import { arenaEnv, planArena, type LlmSeatPlan } from "./plan.ts";
import { reconcileRun } from "./reconcile.ts";
import { runArena, type AdapterContext, type SignalSource } from "./run.ts";
import { FlakyAdapter, RULESET, readCalls, runDir } from "./rig.test.ts";

const SLOW = process.env["PERFIDIA_SLOW"] === "1";
/** A test of the slow suite: skipped unless PERFIDIA_SLOW=1. */
const xtest = test.skipIf(!SLOW);

/** `arena` as the CLI runs it, with no calibration profile unless a test passes `--profiles`. */
const main = (...[argv, io, env, o]: Parameters<typeof arenaMain>) =>
  arenaMain(argv, io, env, { profilesDir: "off", ...o });

const LONG = 120_000;
const PLAN = ["--fake", "--lineup", "claude-duo", "--seed", "1", "--id-key", "seed"];
const FAKE = [...PLAN, "--quiet"];

async function cli(argv: readonly string[], env: Record<string, string> = {}) {
  const io = memoryIo();
  const code = await main(argv, io, env);
  return { code, out: io.stdout(), err: io.stderr() };
}

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Every file under `dir`, relative path → bytes as text. */
function tree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const name of readdirSync(d).toSorted(byName)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(relative(dir, p), readFileSync(p, "utf8"));
    }
  };
  walk(dir);
  return out;
}

const report = (dir: string) =>
  ArenaReportSchema.parse(JSON.parse(readFileSync(join(dir, "arena.json"), "utf8")));

describe("arena estimate (phase 4 §5.3, §5.4)", () => {
  test("claude-duo: the prediction, the reserve and K, as printed", async () => {
    const r = await cli(["estimate", "--lineup", "claude-duo"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "estimate for claude-duo: perfidia-1@1.1.0 · 6 players · 7 game day(s)",
    );
    expect(r.out).toContain(
      "match (scenario, the sum of the seat bounds): $3.47 low · $12.05 central · $44.28 high",
    );
    // The review added US-only inference (1.1×) to every Claude bound: $2.00 → $2.20. Prompt
    // version 3's longer shared block (READING THE INTERFACE, TIMES) raised the probe and the
    // preflight, which price the real prefix: $0.17 → $0.20 each, the reserve $2.20 → $2.25.
    expect(r.out).toContain(
      "reserve $2.25 = attempt bounds $1.85 + one probe $0.20 + start preflight $0.20",
    );
    expect(r.out).toContain("budget $55.00 · kill threshold K = $52.75 (budget − reserve)");
    expect(r.out).toMatch(/p1 +claude-sonnet-5-5 +medium +off /);
    expect(r.out).not.toContain("warning:");
    // One calibration day.
    const day = await cli([
      "estimate",
      "--lineup",
      "claude-duo",
      "--days",
      "1",
      "--budget-usd",
      "10",
    ]);
    expect(day.out).toContain("$0.50 low · $1.72 central · $6.33 high");
  });

  test("the design's $3.69 / $12.59 / $45.68 at its Sonnet 5.5 card ($0.20 reads); phase 2's $83.29", () => {
    // The pricing page checked on 2026-10-20 bills Sonnet 5.5 cache reads at $0.10 (0.05× input);
    // the design priced them at $0.20 from the claude-api skill's cached table. Same cost model:
    const design = { ...requirePrice("claude-sonnet-5-5"), cacheRead: 200 };
    const seat = (days: number, k: "low" | "central" | "high") =>
      estimateSeat("claude-sonnet-5-5", days, "lockstep", "5m", "medium", design)[k] +
      3 * estimateSeat("claude-haiku-5-5", days, "lockstep", "5m", "medium")[k];
    expect(
      [seat(7, "low"), seat(7, "central"), seat(7, "high"), seat(1, "central")].map(formatCents),
    ).toEqual(["$3.69", "$12.59", "$45.68", "$1.80"]);
    // Phase 2's scenario is unchanged: 4 Opus 5.5 seats at medium, 7 lockstep days.
    expect(formatCents(4 * estimateSeat("claude-opus-5-5", 7, "lockstep", "5m").central)).toBe(
      "$83.29",
    );
    // The effort factor (an assumption): Opus 5.5 at low is 0.6 × the output per call.
    expect(formatCents(estimateSeat("claude-opus-5-5", 7, "lockstep", "5m", "low").central)).toBe(
      "$14.60",
    );
  });

  test("claude-family: $190 (high + reserve, rounded up) leaves K over the predicted high; $180 is a warning, not a refusal", async () => {
    const r = await cli(["estimate", "--lineup", "claude-family"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("$13.54 low · $46.38 central · $168.92 high");
    // Prompt version 3: the probe and preflight price a longer prefix (reserve $20.33 → $20.95).
    expect(r.out).toContain("reserve $20.95 = attempt bounds $16.10");
    expect(r.out).toContain("budget $190.00 · kill threshold K = $169.05");
    expect(r.out).not.toContain("warning:");
    const low = await cli(["estimate", "--lineup", "claude-family", "--budget-usd", "180"]);
    expect(low.code).toBe(0);
    expect(low.out).toContain("warning: budget $180.00 leaves K = $159.05");
    expect(low.out).toContain("below the predicted high $168.92: the kill switch might fire");
  });

  test("a budget whose K falls below the predicted low exits 3 with the §4.2 message; nothing is written", async () => {
    const dir = runDir();
    for (const command of [
      ["estimate", ...PLAN],
      ["run", "--out", dir, ...FAKE],
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- the same refusal from both commands
      const r = await cli([...command, "--budget-usd", "5"]);
      expect(r.code).toBe(3);
      expect(r.err).toContain(
        "budget $5.00 leaves K = $2.75 after the reserve ($2.25 = attempt bounds $1.85 + one probe $0.20 + start preflight $0.20), below the predicted low $3.47: raise --budget-usd",
      );
    }
    expect(existsSync(dir)).toBe(false);
    // A lineup with a non-Anthropic seat plans (Pass 1b); a real run of it needs that provider's
    // key too (Pass 2: every provider has an adapter).
    const bad = join(runDir("lineup"), "..", "mixed.json");
    const mixed = LineupSchema.parse(
      JSON.parse(
        readFileSync(join(import.meta.dir, "..", "..", "lineups", "claude-duo.json"), "utf8"),
      ),
    );
    mixed.seats[1] = {
      seat: "p2",
      kind: "llm",
      provider: "google",
      model: "gemini-3.8-flash",
      profile: "achilles@1",
    };
    writeFileSync(bad, JSON.stringify(mixed));
    const planned = await cli(["estimate", "--lineup", bad]);
    expect(planned.code).toBe(0);
    expect(planned.out).toMatch(/p2 +gemini-3\.8-flash +medium/);
    const refused = await cli(["run", "--lineup", bad, "--out", dir], {
      PERFIDIA_ANTHROPIC_API_KEY: "k",
      // Loopback, a closed port: were the refusal to fail, nothing would leave the machine.
      PERFIDIA_ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
      PERFIDIA_GOOGLE_BASE_URL: "http://127.0.0.1:9",
    });
    expect(refused.code).toBe(3);
    expect(refused.err).toContain("PERFIDIA_GOOGLE_API_KEY is not set: the LLM seats (p2) need it");
    expect(existsSync(dir)).toBe(false);
  });
});

describe("arena run --fake --lineup claude-duo (phase 4 Pass 1a)", () => {
  xtest(
    "2 days, budget $55: Level E, estimate.json before turn 1 with its sha in seats.json, exit4, byte-identical runs",
    async () => {
      const dirs = [runDir("a"), runDir("b")];
      for (const dir of dirs) {
        // oxlint-disable-next-line no-await-in-loop -- two identical runs
        const r = await cli(["run", ...FAKE, "--days", "2", "--budget-usd", "55", "--out", dir]);
        expect(r.code).toBe(0);
      }
      const [a, b] = dirs.map(tree);
      expect([...(a?.keys() ?? [])]).toEqual([...(b?.keys() ?? [])]);
      for (const [name, text] of a ?? []) {
        // summary.json holds the wall-clock duration; everything else is byte-identical.
        if (name !== "summary.json") expect([name, b?.get(name)]).toEqual([name, text]);
      }
      const dir = dirs[0] ?? "";
      const estimateText = readFileSync(join(dir, "estimate.json"), "utf8");
      const estimate = EstimateFileSchema.parse(JSON.parse(estimateText));
      const seats = SeatsFileSchema.parse(
        JSON.parse(readFileSync(join(dir, "seats.json"), "utf8")),
      );
      expect(seats.estimateSha256).toBe(sha256Hex(estimateText));
      expect([seats.lineup, seats.promptCapTokens, seats.budgetNanoUsd]).toEqual([
        "claude-duo",
        160_000,
        55_000_000_000,
      ]);
      expect(
        seats.seats.flatMap((s) => (s.kind === "llm" ? [[s.model, s.fallbacks]] : [])),
      ).toEqual([
        ["claude-sonnet-5-5", "off"],
        ["claude-haiku-5-5", "off"],
        ["claude-haiku-5-5", "off"],
        ["claude-haiku-5-5", "off"],
      ]);
      expect([estimate.days, estimate.budget?.budgetNanoUsd, estimate.match.source]).toEqual([
        2,
        55_000_000_000,
        "scenario",
      ]);
      const r = report(dir);
      expect(r.format).toBe("perfidia-arena/2");
      expect(r.status).toBe("ended");
      expect(r.levelE?.ok).toBe(true);
      expect(verifyLog(readLog(join(dir, "match.jsonl"))).ok).toBe(true);
      expect(r.budget.estimate?.sha256).toBe(seats.estimateSha256);
      expect(r.budget.under).toBe(true);
      expect(r.budget.killSwitch).toBeNull();
      // Every figure is a sum of logged lines.
      const calls = readCalls(dir);
      const logged = calls.reduce(
        (n, l) => n + (l.k === "llm_call" || l.k === "preflight" ? l.costNanoUsd : 0),
        0,
      );
      expect(r.budget.actualNanoUsd).toBe(logged);
      expect(r.totals.costNanoUsd).toBe(logged);
      expect(
        calls.filter((l) => l.k === "preflight").map((l) => l.k === "preflight" && l.group),
      ).toEqual(["fake/claude-sonnet-5-5/medium", "fake/claude-haiku-5-5/medium"]);
      // exit4: computed; not met until reconciled (and a 2-day fake run spends under the 2-day low).
      expect(r.exit4).toEqual({
        models: 2,
        ended: true,
        estimateStored: true,
        noHandoff: true,
        withinPrediction: r.budget.attemptsNanoUsd >= estimate.match.low,
        under: true,
        levelE: true,
        reconciled: null,
        met: false,
      });
    },
    LONG,
  );

  test(
    "estimate.json and seats.json exist before the first model call",
    async () => {
      const dir = runDir();
      const plan = planArena(
        { ruleset: RULESET, fake: true, seed: 1, idKey: "seed", lineup: "claude-duo", days: 1 },
        arenaEnv({}),
      );
      const seen: string[] = [];
      const adapterFor = (
        s: LlmSeatPlan,
        spec: ConstructorParameters<typeof FakeAdapter>[0],
        ctx: AdapterContext,
      ) => {
        const inner = botBrain({ label: s.brain, seat: s.seat, seed: ctx.seed, model: s.model });
        const brain: Brain = (req, n) => {
          if (seen.length === 0) {
            const text = readFileSync(join(dir, "estimate.json"), "utf8");
            const seats = SeatsFileSchema.parse(
              JSON.parse(readFileSync(join(dir, "seats.json"), "utf8")),
            );
            const turns = readLog(join(dir, "match.jsonl")).filter((l) => l.k === "turn");
            seen.push(`${seats.estimateSha256 === sha256Hex(text)} ${turns.length}`);
          }
          return inner(req, n);
        };
        return new FakeAdapter(spec, brain);
      };
      const out = await runArena(plan, { dir, io: memoryIo(), quiet: true, adapterFor });
      expect(out.code).toBe(0);
      // The sha matched and no turn line was in the log yet.
      expect(seen).toEqual(["true 0"]);
    },
    LONG,
  );

  xtest(
    "a budget just above the refusal threshold fires the kill switch: every seat handed off match_budget, under budget, the match ends",
    async () => {
      const base = {
        ruleset: RULESET,
        fake: true,
        seed: 1,
        idKey: "seed",
        lineup: "claude-duo",
        days: 4,
      };
      const probe = planArena({ ...base, budgetUsd: "1000" }, arenaEnv({}));
      const threshold = probe.prediction.match.low + probe.prediction.reserve.reserveNanoUsd;
      const cents = Math.ceil(threshold / 10_000_000) + 1;
      // Two cents lower is refused: the threshold is where the plan says it is.
      expect(() => planArena({ ...base, budgetUsd: centsText(cents - 2) }, arenaEnv({}))).toThrow(
        "below the predicted low",
      );
      const dir = runDir();
      const r = await cli([
        "run",
        ...FAKE,
        "--days",
        "4",
        "--budget-usd",
        centsText(cents),
        "--transcripts",
        "off",
        "--out",
        dir,
      ]);
      expect(r.code).toBe(0);
      expect(r.err).toContain("ALERT: the match budget's kill switch fired");
      const calls = readCalls(dir);
      const handoffs = calls.filter((l) => l.k === "handoff");
      expect(handoffs.map((h) => h.k === "handoff" && [h.seat, h.reason])).toEqual([
        ["p1", "match_budget"],
        ["p2", "match_budget"],
        ["p3", "match_budget"],
        ["p4", "match_budget"],
      ]);
      const kill = calls.find((l) => l.k === "kill_switch");
      const killT = kill?.k === "kill_switch" ? kill.t : -1;
      // No model attempt is made after the kill: every llm_call was built at or before it.
      const after = calls.filter(
        (l): l is Extract<LlmLogLine, { k: "llm_call" }> => l.k === "llm_call",
      );
      expect(after.every((l) => l.t <= killT)).toBe(true);
      const rep = report(dir);
      expect(rep.status).toBe("ended");
      expect(rep.levelE?.ok).toBe(true);
      expect(rep.budget.killSwitch?.fired).toBe(true);
      expect(rep.budget.under).toBe(true);
      expect(rep.budget.actualNanoUsd).toBeLessThanOrEqual(cents * 10_000_000);
      expect(rep.budget.actualNanoUsd).toBeGreaterThanOrEqual(rep.budget.killAtNanoUsd ?? 0);
      expect(rep.seats.map((s) => s.handoff?.reason)).toEqual([
        "match_budget",
        "match_budget",
        "match_budget",
        "match_budget",
      ]);
      expect([rep.exit4.noHandoff, rep.exit4.met]).toEqual([false, false]);
      // The match played on with bots: a controller line for each seat at its next turn, then the end.
      const lines = readLog(join(dir, "match.jsonl"));
      const controllers = lines.flatMap((l) => (l.k === "controller" ? [l.seat] : []));
      expect(controllers.toSorted(byName)).toEqual(["p1", "p2", "p3", "p4"]);
      expect(lines.at(-1)?.k).toBe("end");
    },
    LONG,
  );
});

/** `c` cents as `--budget-usd` text. */
const centsText = (c: number): string =>
  `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;

/** `nano` nano-USD as exact `--usd` text. */
const nanoText = (nano: number): string =>
  `${Math.floor(nano / 1e9)}.${String(nano % 1e9).padStart(9, "0")}`;

/** A signal source the test fires. */
function signals(): { source: SignalSource; emit: (s: string) => void; subscribed: () => boolean } {
  let handler: ((s: string) => void) | null = null;
  return {
    source: {
      subscribe: (h) => {
        handler = h;
        return () => {
          handler = null;
        };
      },
    },
    emit: (s) => handler?.(s),
    subscribed: () => handler !== null,
  };
}

/** The two-day fake claude-duo plan the operator tests run. */
const operatorPlan = () =>
  planArena(
    { ruleset: RULESET, fake: true, seed: 1, idKey: "seed", lineup: "claude-duo", days: 2 },
    arenaEnv({}),
  );

/** Bot-backed fake adapters that send SIGINT at the `at`-th model call of the match. */
function firing(sig: ReturnType<typeof signals>, at: number) {
  let n = 0;
  return (
    s: LlmSeatPlan,
    spec: ConstructorParameters<typeof FakeAdapter>[0],
    ctx: AdapterContext,
  ) => {
    const inner = botBrain({ label: s.brain, seat: s.seat, seed: ctx.seed, model: s.model });
    const brain: Brain = (req, k) => {
      n += 1;
      if (n === at) sig.emit("SIGINT");
      return inner(req, k);
    };
    return new FakeAdapter(spec, brain);
  };
}

describe("operator signals (phase 4 §5.2)", () => {
  xtest(
    "SIGINT once: no attempt after it, every LLM seat handed to its bot (operator), the match ends",
    async () => {
      const sig = signals();
      const dir = runDir();
      const out = await runArena(operatorPlan(), {
        dir,
        io: memoryIo(),
        quiet: true,
        signals: sig.source,
        adapterFor: firing(sig, 40),
      });
      expect(out.status).toBe("ended");
      expect(out.code).toBe(0);
      expect(sig.subscribed()).toBe(false);
      const calls = readCalls(dir);
      const op = calls.filter((l) => l.k === "operator");
      expect(op.map((l) => l.k === "operator" && [l.signal, l.action])).toEqual([
        ["SIGINT", "handoff"],
      ]);
      const at = calls.findIndex((l) => l.k === "operator");
      // The attempt in flight at the signal (the 40th) is logged; none starts after it.
      expect(calls.slice(at + 1).filter((l) => l.k === "llm_call").length).toBeLessThanOrEqual(1);
      expect(
        calls.filter((l) => l.k === "handoff").map((l) => l.k === "handoff" && l.reason),
      ).toEqual(["operator", "operator", "operator", "operator"]);
      expect(out.report.levelE?.ok).toBe(true);
    },
    LONG,
  );

  test(
    "one Ctrl-C under `bun run` (two copies 3 ms apart) through the CLI's source: a hand-off, no abort",
    async () => {
      // The M1 rehearsal: the terminal and `bun run` both deliver it; 3 of 6 runs aborted.
      let ms = 0;
      const source = processSignalsOf(
        () => undefined,
        () => ms,
      );
      const ctrlC = {
        source,
        emit: () => {
          process.emit("SIGINT", "SIGINT");
          ms += 3;
          process.emit("SIGINT", "SIGINT");
        },
        subscribed: () => true,
      };
      const dir = runDir();
      const plan = planArena(
        {
          ruleset: RULESET,
          fake: true,
          seed: 1,
          idKey: "seed",
          lineup: "claude-duo",
          days: 2,
          stopAfterDays: 1,
        },
        arenaEnv({}),
      );
      const out = await runArena(plan, {
        dir,
        io: memoryIo(),
        quiet: true,
        signals: source,
        adapterFor: firing(ctrlC, 40),
      });
      expect([out.status, out.code]).toEqual(["stopped", 0]);
      const calls = readCalls(dir);
      expect(calls.flatMap((l) => (l.k === "operator" ? [[l.signal, l.action]] : []))).toEqual([
        ["SIGINT", "handoff"],
      ]);
      expect(calls.flatMap((l) => (l.k === "handoff" ? [l.reason] : []))).toEqual([
        "operator",
        "operator",
        "operator",
        "operator",
      ]);
      expect(out.report.levelE?.ok).toBe(true);
    },
    LONG,
  );

  test(
    "SIGINT twice: the run aborts (exit 2, status aborted, the log cut)",
    async () => {
      const sig = signals();
      const dir = runDir();
      const io = memoryIo();
      let days = 0;
      const out = await runArena(operatorPlan(), {
        dir,
        io: {
          out: (t) => {
            io.out(t);
            // The second signal a game day after the first.
            if (t.startsWith("D2 00:00")) {
              days += 1;
              sig.emit("SIGINT");
            }
          },
          err: (t) => io.err(t),
        },
        signals: sig.source,
        adapterFor: firing(sig, 40),
      });
      expect(days).toBe(1);
      expect([out.status, out.code]).toEqual(["aborted", 2]);
      expect(out.report.reason).toContain("the operator sent a second signal");
      const calls = readCalls(dir);
      expect(
        calls.filter((l) => l.k === "operator").map((l) => l.k === "operator" && l.action),
      ).toEqual(["handoff", "abort"]);
      expect(readLog(join(dir, "match.jsonl")).at(-1)?.k).not.toBe("end");
    },
    LONG,
  );
});

/** One message's usage: 1,000 cache-write tokens of `model`. */
const usage = (model: string) => [
  {
    model,
    kind: "message" as const,
    tokens: { input: 0, cacheWrite5m: 1000, cacheWrite1h: 0, cacheRead: 0, output: 0 },
    estimated: false,
  },
];

/** A billing failure that still spent `spent`. */
const billing = (spent: ReturnType<typeof usage> = []) =>
  new ModelError("billing", "credit balance too low", { status: 402, spent });

describe("probes, carry (phase 4 §5.2, §5.5)", () => {
  xtest(
    "a failed probe's spend is charged and logged; probes stop once every seat is halted",
    async () => {
      const sig = signals();
      let down = false;
      let probes = 0;
      const adapterFor = (
        s: LlmSeatPlan,
        spec: ConstructorParameters<typeof FakeAdapter>[0],
        ctx: AdapterContext,
      ) => {
        const inner = botBrain({ label: s.brain, seat: s.seat, seed: ctx.seed, model: s.model });
        let fired = false;
        const brain: Brain = (req, n) => {
          if (s.seat === "p1" && req.meta.turn === 3 && !fired) {
            fired = true;
            down = true;
            return billing();
          }
          return inner(req, n);
        };
        return new FlakyAdapter(spec, brain, () => {
          if (!down) return null;
          probes += 1;
          // The first probe fails after billing its shape check; then the operator halts the seats
          // during the pause: no further probe runs, the gate reopens, the seats hand off.
          if (probes === 1) {
            sig.emit("SIGINT");
            return billing(usage(s.model));
          }
          return billing();
        });
      };
      const plan = planArena(
        { ruleset: RULESET, fake: true, seed: 1, idKey: "seed", lineup: "claude-duo", days: 1 },
        arenaEnv({}),
      );
      const dir = runDir();
      const out = await runArena(plan, {
        dir,
        io: memoryIo(),
        quiet: true,
        signals: sig.source,
        adapterFor,
        probeEveryMs: 60_000,
      });
      expect(out.status).toBe("ended");
      const calls = readCalls(dir);
      const probeLines = calls.filter((l) => l.k === "preflight" && l.phase === "probe");
      // One probe ran: its first group failed (billing) after billing 1 000 cache-write tokens on
      // Sonnet 5.5; the preflight stopped there (the seats were halted), and no probe followed.
      expect(
        probeLines.map((l) => l.k === "preflight" && [l.model, l.ok, l.costNanoUsd, l.error?.kind]),
      ).toEqual([["claude-sonnet-5-5", false, 1000 * 2500, "billing"]]);
      expect(probes).toBe(1);
      expect(out.report.budget.probeNanoUsd).toBe(1000 * 2500);
      expect(out.report.totals.preflightNanoUsd).toBe(1000 * 2500);
      expect(out.report.pauses.map((p) => p.outcome)).toEqual(["resumed"]);
      expect(
        calls.filter((l) => l.k === "handoff").map((l) => l.k === "handoff" && l.reason),
      ).toEqual(["operator", "operator", "operator", "operator"]);
    },
    LONG,
  );

  xtest(
    "--budget-carry: a crashed run's logged spend counts from the start (and toward the refusal)",
    async () => {
      const first = runDir("first");
      expect(
        (await cli(["run", ...FAKE, "--days", "1", "--budget-usd", "10", "--out", first])).code,
      ).toBe(0);
      const spent = readCalls(first).reduce(
        (n, l) => n + (l.k === "llm_call" || l.k === "preflight" ? l.costNanoUsd : 0),
        0,
      );
      expect(spent).toBeGreaterThan(0);
      const second = runDir("second");
      const r = await cli([
        "run",
        ...FAKE,
        "--days",
        "1",
        "--budget-usd",
        "10",
        "--budget-carry",
        first,
        "--out",
        second,
      ]);
      expect(r.code).toBe(0);
      const calls = readCalls(second);
      const carry = calls[0];
      expect(carry?.k === "carry" && [carry.from, carry.lines > 0, carry.costNanoUsd]).toEqual([
        "first",
        true,
        spent,
      ]);
      expect(Object.keys(carry ?? {}).toSorted(byName)).toEqual([
        "costNanoUsd",
        "from",
        "k",
        "lines",
      ]);
      const rep = report(second);
      expect(rep.budget.carryNanoUsd).toBe(spent);
      expect(rep.budget.actualNanoUsd).toBeLessThan(rep.totals.costNanoUsd + 1);
      const est = EstimateFileSchema.parse(
        JSON.parse(readFileSync(join(second, "estimate.json"), "utf8")),
      );
      expect(est.budget?.carryNanoUsd).toBe(spent);
      // A carry that leaves less than the predicted low is refused.
      const low = est.match.low + est.reserve.reserveNanoUsd + spent;
      const tight = `${Math.floor((low - 20_000_000) / 1e9)}.${String(Math.floor(((low - 20_000_000) % 1e9) / 1e7)).padStart(2, "0")}`;
      const refused = await cli([
        "estimate",
        ...PLAN,
        "--days",
        "1",
        "--budget-usd",
        tight,
        "--budget-carry",
        first,
      ]);
      expect(refused.code).toBe(3);
      expect(refused.err).toContain(`and the carry ${formatCents(spent)}, below the predicted low`);
    },
    LONG,
  );
});

describe("arena reconcile (phase 4 §5.6)", () => {
  xtest(
    "within tolerance: reconcile.json, exit 0, exit4.reconciled true; outside: exit 4",
    async () => {
      const dir = runDir();
      expect(
        (await cli(["run", ...FAKE, "--days", "1", "--budget-usd", "10", "--out", dir])).code,
      ).toBe(0);
      const calls = readCalls(dir);
      const ledger = calls.reduce(
        (n, l) => n + (l.k === "llm_call" || l.k === "preflight" ? l.costNanoUsd : 0),
        0,
      );
      const ok = await cli(["reconcile", dir, "--usd", `fake=${nanoText(ledger)}`]);
      expect(ok.code).toBe(0);
      expect(ok.err).toContain("wall-clock times are virtual");
      const file = ReconcileFileSchema.parse(
        JSON.parse(readFileSync(join(dir, "reconcile.json"), "utf8")),
      );
      expect(file.ok).toBe(true);
      expect(
        file.providers.map((p) => [
          p.provider,
          p.ledgerNanoUsd,
          p.reportedNanoUsd,
          p.toleranceNanoUsd,
        ]),
      ).toEqual([["fake", ledger, ledger, 250_000_000]]);
      expect(report(dir).exit4.reconciled).toBe(true);
      // $1 over the ledger is outside max(3%, $0.25): exit 4, and exit4 says so.
      const off = await cli([
        "reconcile",
        dir,
        "--usd",
        `fake=${nanoText(ledger + 1_000_000_000)}`,
      ]);
      expect(off.code).toBe(4);
      expect(off.out).toContain("OUTSIDE tolerance (exit 4)");
      expect(report(dir).exit4.reconciled).toBe(false);
      // Tokens first: dollars within tolerance but a token count 5% off is exit 4 too.
      let output = 0;
      for (const l of calls) {
        if (l.k === "llm_call" && l.model === "claude-haiku-5-5")
          for (const u of l.usage) output += u.output;
      }
      const input = join(dir, "..", "usage.json");
      writeFileSync(
        input,
        JSON.stringify({
          format: "perfidia-reconcile-input/1",
          providers: [
            {
              provider: "fake",
              usd: nanoText(ledger),
              tokens: [{ model: "claude-haiku-5-5", output: Math.round(output * 1.05) }],
            },
          ],
        }),
      );
      const tokens = await cli(["reconcile", dir, "--input", input]);
      expect(tokens.code).toBe(4);
      expect(tokens.out).toContain("claude-haiku-5-5 output");
      expect(tokens.out).toContain("OFF by more than 2%");
      // Usage required, and only one way to give it.
      expect((await cli(["reconcile", dir])).code).toBe(3);
    },
    LONG,
  );

  test("the window: under 48 hours after the run's wall-clock end is early; estimated output is the excess", () => {
    const line: LlmLogLine = {
      k: "llm_call",
      seat: "p1",
      turn: 1,
      round: 0,
      attempt: 1,
      kind: "round",
      t: 0,
      latencyMs: 1,
      ttftMs: null,
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      servedBy: null,
      effort: "medium",
      maxTokens: 16_000,
      stop: "error",
      rawStop: null,
      refusal: null,
      fallback: false,
      cacheMiss: false,
      usage: [
        {
          model: "claude-sonnet-5-5",
          kind: "message",
          input: 1000,
          cacheWrite5m: 0,
          cacheWrite1h: 0,
          cacheRead: 0,
          output: 16_000,
          estimated: true,
        },
      ],
      costNanoUsd: 1000 * 2000 + 16_000 * 10_000,
      seatSpentNanoUsd: 0,
      capNanoUsd: 1,
      wakeSpentNanoUsd: 0,
      unpriced: [],
      calls: 0,
      textChars: 0,
      reasoningChars: 0,
      requestId: null,
      error: { kind: "connection", status: null, message: "the stream broke" },
    };
    const wall = { start: "2026-10-20T08:00:00.000Z", end: "2026-10-20T20:00:00.000Z" };
    const input = {
      format: "perfidia-reconcile-input/1" as const,
      // The provider billed only the prompt: the estimated output never happened.
      providers: [{ provider: "anthropic", usd: "0.002" }],
    };
    const early = reconcileRun([line], input, wall, Date.parse("2026-10-21T20:00:00.000Z"));
    expect([early.hoursAfterEnd, early.early, early.ok]).toEqual([24, true, true]);
    const p = early.providers[0];
    expect([p?.estimatedExcessNanoUsd, p?.lowNanoUsd]).toEqual([160_000_000, 0]);
    const late = reconcileRun([line], input, wall, Date.parse("2026-10-23T20:00:00.000Z"));
    expect([late.hoursAfterEnd, late.early]).toEqual([72, false]);
  });
});

describe("keys never follow a redirect (phase 4 §7)", () => {
  const servers: { stop(force?: boolean): void }[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.stop(true);
  });

  test("arena run against a redirecting base URL: exit 3, nothing written, the target gets nothing, no key printed", async () => {
    const key = "sk-ant-planted-cli-9876543210";
    const seen: string[] = [];
    const b = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        seen.push(req.headers.get("x-api-key") ?? "");
        return new Response("{}", { status: 200 });
      },
    });
    const a = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const u = new URL(req.url);
        return new Response(null, {
          status: 307,
          headers: { location: `http://127.0.0.1:${b.port}${u.pathname}${u.search}` },
        });
      },
    });
    servers.push(a, b);
    const dir = runDir();
    const r = await cli(
      ["run", "--lineup", "claude-duo", "--days", "1", "--seed", "1", "--out", dir, "--quiet"],
      {
        PERFIDIA_ANTHROPIC_API_KEY: key,
        PERFIDIA_ANTHROPIC_BASE_URL: `http://127.0.0.1:${a.port}`,
      },
    );
    expect(r.code).toBe(3);
    expect(r.err).toContain("preflight of anthropic/claude-sonnet-5-5/medium: connection");
    expect(r.err).toContain("(nothing was written)");
    expect(existsSync(dir)).toBe(false);
    expect(seen).toEqual([]);
    expect(`${r.out}${r.err}`).not.toContain(key);
  });
});
