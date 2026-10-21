// The arena end to end, with no network (phase-2 design §7, items 7–8): LLM seats on bot-backed fake
// models (one bot instance per seat: opportunist@3, conqueror@3, expander@2, turtle@3) and the two
// default bots, on perfidia-1@1.1.0, through `runArena` into a run directory.
// - A full 2-day lockstep match completes, replays at Level E, rebuilds the live gateway state,
//   writes every file of the run directory, and reports the exit criterion (the 7-day matches are
//   in the exit suite, `bun run test:exit`).
// - `--stop-after 1` stops a 7-day match at the end of day 1: the agents were told 7 days, Level E
//   holds up to the cut, the spend is projected from one day; a one-hour match reports a fraction
//   of a day.
// - Two runs are identical (match log, LLM log, report, transcripts).
// - A seat over its cap is handed to its bot mid-match.
// - A model error closes only its turn; a retryable one is retried; the match goes on.
// - An operator-recoverable failure pauses a lockstep arena (game time stands still) and the
//   preflight probe resumes it; a pause longer than --pause-max aborts the arena: every turn of the
//   aborted second closes, the log is cut there, arena.json says why, the exit code is 2.
// - A breaker whose cause the preflight cannot see (a 400 from round 1 on) trips again after its
//   resume: the arena aborts instead of playing on with dead LLM seats.
// - Two consecutive refused turns of a seat are an alert naming their inbox message ids.
// - Phase 3: `replies.jsonl` holds one line per reply the conversation keeps, right after its
//   `llm_call` line, with the fake brain's reasoning; `match.jsonl` is on disk line by line while
//   the run goes (a seat's wake line is there before its first model call).
// The two-run determinism check, the capped seat's 2-day hand-off, the billing pause, --stop-after,
// replies.jsonl and the refused-turns alert run in the slow suite (PERFIDIA_SLOW=1,
// docs/architecture.md §13.8: `bun run test:slow`, run by `bun run test:exit`).

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { verifyLog } from "@perfidia/engine";
import { canonicalJson } from "@perfidia/engine/core";
import { rebuildGatewayState } from "@perfidia/gateway/runtime";
import { findRuleset } from "@perfidia/engine";
import { LogLineSchema, ReplyLineSchema, type LogLine, type TurnLine } from "@perfidia/protocol";
import { harness, summarize } from "@perfidia/sim";
import { ModelError } from "../model/adapter.ts";
import { projectSpend } from "./cost.ts";
import { FakeAdapter, type Brain } from "../model/fake.ts";
import { botBrain } from "./brain.ts";
import type { AdapterContext } from "./run.ts";
import type { LlmSeatPlan } from "./plan.ts";
import { FlakyAdapter, fakePlan, play, runDir } from "./rig.test.ts";

const SLOW = process.env["PERFIDIA_SLOW"] === "1";
/** A test of the slow suite: skipped unless PERFIDIA_SLOW=1. */
const xtest = test.skipIf(!SLOW);

const LONG = 120_000;
const resolve = (ref: string) => findRuleset(ref);

const turns = (lines: readonly LogLine[]): TurnLine[] =>
  lines.filter((l): l is TurnLine => l.k === "turn");

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const billing = (): ModelError =>
  new ModelError("billing", "credit balance too low", { status: 402 });

/** p2's model: a 400 on turn 3, a 429 once on turn 5's second round, else the bot. */
function failing(inner: Brain): Brain {
  let limited = false;
  return (req, n) => {
    const m = req.meta;
    if (m.turn === 3 && m.round === 0) {
      return new ModelError("bad_request", "messages: invalid", { status: 400 });
    }
    if (m.turn === 5 && m.round === 1 && !limited) {
      limited = true;
      return new ModelError("rate_limit", "slow down", { status: 429, retryAfterMs: 1500 });
    }
    return inner(req, n);
  };
}

/** A 400 on every request from round 1 on: a shape the preflight never sends. */
const round1 =
  (inner: Brain): Brain =>
  (req, n) =>
    req.meta.round >= 1
      ? new ModelError("bad_request", "messages.2: unexpected role system", { status: 400 })
      : inner(req, n);

/** Refuses the first round of turns 2 and 3. */
const refusing =
  (inner: Brain): Brain =>
  (req, n) =>
    req.meta.round === 0 && (req.meta.turn === 2 || req.meta.turn === 3)
      ? {
          stop: "refusal",
          refusal: { category: "cyber", explanation: null, recommendedModel: null },
        }
      : inner(req, n);

/**
 * Refuses every round from turn 2 on: refusals close their turns without counting toward the
 * breaker, a quiet dead match.
 */
const refuseAll =
  (inner: Brain): Brain =>
  (req, n) =>
    req.meta.turn >= 2
      ? { stop: "refusal", refusal: { category: null, explanation: null, recommendedModel: null } }
      : inner(req, n);

/** The bot-backed brain the arena gives a fake seat, with `wrap` around it. */
function wrapped(
  wrap: (inner: Brain) => Brain,
  only?: string,
): (
  s: LlmSeatPlan,
  spec: ConstructorParameters<typeof FakeAdapter>[0],
  ctx: AdapterContext,
) => FakeAdapter {
  return (s, spec, ctx) => {
    const inner = botBrain({ label: s.brain, seat: s.seat, seed: ctx.seed, model: s.model });
    return new FakeAdapter(spec, only === undefined || only === s.seat ? wrap(inner) : inner);
  };
}

describe("arena: a full lockstep match on fake models", () => {
  test(
    "completes, replays at Level E, rebuilds the gateway state, writes the run directory, reports the exit criterion",
    async () => {
      const plan = fakePlan({ days: 2 });
      const dir = runDir();
      const run = await play(plan, { dir });
      const { lines, llm, report } = run;

      // Completed.
      expect(run.outcome.code).toBe(0);
      expect(run.outcome.status).toBe("ended");
      expect(lines.at(-1)?.k).toBe("end");
      expect(lines.some((l) => l.k === "fatal")).toBe(false);
      expect(lines.some((l) => l.k === "gw" && l.r.code === "INTERNAL")).toBe(false);
      expect(report.status).toBe("ended");
      expect(report.endedAt).toBe(2 * 86400);

      // Level E, and the gateway rebuild equals the live state.
      const e = verifyLog(lines);
      expect(e.divergence).toBeUndefined();
      expect(e.ok).toBe(true);
      expect(report.levelE).toEqual({
        ok: true,
        actions: e.actions,
        checkpoints: e.checkpoints,
        divergence: null,
      });
      const rebuilt = rebuildGatewayState(lines, resolve);
      expect(rebuilt.ok).toBe(true);
      expect(rebuilt.inTurn).toBe(false);
      expect(canonicalJson(rebuilt.gw)).toBe(canonicalJson(run.outcome.result?.gateway ?? null));

      // The run directory.
      for (const f of [
        "match.jsonl",
        "llm_calls.jsonl",
        "summary.json",
        "seats.json",
        "arena.json",
        "feed.txt",
      ]) {
        expect(existsSync(join(dir, f))).toBe(true);
      }
      expect(readdirSync(join(dir, "prompts")).toSorted(byText)).toEqual([
        "operator.json",
        "p1.txt",
        "p2.txt",
        "p3.txt",
        "p4.txt",
        "shared.txt",
        "tools.json",
      ]);
      expect(readdirSync(join(dir, "transcripts")).toSorted(byText)).toEqual([
        "p1",
        "p2",
        "p3",
        "p4",
      ]);
      expect(readdirSync(join(dir, "snapshots"))).toContain("final.json");
      const feed = readFileSync(join(dir, "feed.txt"), "utf8");
      expect(feed).toContain("p1 Odysseus thinks:");
      expect(feed).toContain("match ended (time)");
      const summary: unknown = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
      expect(summary).toMatchObject({ status: "ended" });

      // seats.json names what played; the header carries the same labels.
      const header = lines[0];
      expect(header?.k).toBe("header");
      for (const s of run.seats.seats) {
        expect(header?.k === "header" ? header.controllers[s.seat] : "").toBe(s.label);
      }
      expect(run.seats.seats.filter((s) => s.kind === "llm").map((s) => s.label)).toEqual([
        "llm:fake/claude-opus-5-5/medium:odysseus@1:p3",
        "llm:fake/claude-opus-5-5/medium:achilles@1:p3",
        "llm:fake/claude-opus-5-5/medium:penelope@1:p3",
        "llm:fake/claude-opus-5-5/medium:agamemnon@1:p3",
      ]);

      // One llm_call line per model call: every round of an LLM turn is one call (no retries here).
      const llmSeats = ["p1", "p2", "p3", "p4"];
      const llmTurns = turns(lines).filter((l) => llmSeats.includes(l.seat));
      expect(llm.length).toBe(llmTurns.reduce((n, l) => n + l.rounds, 0));
      expect(llm.every((l) => l.error === null && l.kind === "round")).toBe(true);
      // The ledger: the report's totals are the lines' sum, and each seat's running total ends there.
      expect(report.totals.costNanoUsd).toBe(llm.reduce((n, l) => n + l.costNanoUsd, 0));
      for (const s of report.seats) {
        expect(llm.findLast((l) => l.seat === s.seat)?.seatSpentNanoUsd).toBe(s.costNanoUsd);
      }
      // Fake usage is cache-shaped: no cache miss, most prompt tokens read from the cache.
      expect(report.seats.every((s) => s.cacheMisses === 0)).toBe(true);
      expect(report.totals.cacheReadPct).toBeGreaterThan(70);

      // Public thoughts on every LLM turn (the fake replies with the bot's thought).
      expect(llmTurns.every((l) => l.thought !== undefined)).toBe(true);
      for (const s of report.seats) expect(s.thoughts.withThought).toBe(s.thoughts.turns);

      // The stable prefix: one shared block and one tool list for every request, one seat block per seat.
      const shared = new Set<string>();
      const tools = new Set<string>();
      for (const seat of llmSeats) {
        const seatBlocks = new Set<string>();
        for (const f of readdirSync(join(dir, "transcripts", seat))) {
          for (const row of readFileSync(join(dir, "transcripts", seat, f), "utf8").split("\n")) {
            if (row === "") continue;
            const rec: unknown = JSON.parse(row);
            const prefix: unknown =
              rec !== null && typeof rec === "object" ? Reflect.get(rec, "prefix") : undefined;
            if (prefix === undefined || prefix === null || typeof prefix !== "object") continue;
            shared.add(String(Reflect.get(prefix, "shared")));
            tools.add(String(Reflect.get(prefix, "tools")));
            seatBlocks.add(String(Reflect.get(prefix, "seat")));
          }
        }
        expect([seat, seatBlocks.size]).toEqual([seat, 1]);
      }
      expect([shared.size, tools.size]).toEqual([1, 1]);

      // The exit criterion, as counted from the log (reported; fake brains do not decide it).
      const sum = summarize(lines);
      expect(report.exit.alliancesFormed).toBe(sum.events.alliancesFormed);
      expect(report.exit.betrayals).toBe(sum.events.betrayals);
      expect(report.exit.met).toBe(sum.events.alliancesFormed > 0 && sum.events.betrayals > 0);
      expect(report.exit.llm.betrayals).toBeLessThanOrEqual(report.exit.betrayals);
      // A 2-day match is projected to a week (§5.5).
      expect(report.projection).toMatchObject({ fromDays: 2, toDays: 7 });
      expect(report.projection.costNanoUsd).toBe(
        report.seats.reduce((n, s) => n + projectSpend(s.costNanoUsd, 2, 7), 0),
      );
      expect(run.stdout).toContain("exit criterion:");
      expect(run.stdout).toContain("Level E: ok");
      // One line per seat at the game-day boundary from the daily tripwire (D2).
      expect(report.daily.length).toBe(4);
      console.log(
        `2-day fake arena: ${report.exit.alliancesFormed} alliance(s), ${report.exit.betrayals} betrayal(s), exit criterion ${report.exit.met ? "met" : "not met"}; with an LLM seat: ${report.exit.llm.betrayals} betrayal(s), ${report.exit.llm.met ? "met" : "not met"}; ${llm.length} model calls, Level E ${e.actions} actions / ${e.checkpoints} checkpoints`,
      );
    },
    LONG,
  );
});

describe("arena: spectator data (phase 3)", () => {
  xtest(
    "replies.jsonl: one line per kept reply, reasoning included; match.jsonl on disk line by line",
    async () => {
      const dir = runDir();
      const probe: { lines: LogLine[] | null } = { lines: null };
      const adapterFor = (
        s: LlmSeatPlan,
        spec: ConstructorParameters<typeof FakeAdapter>[0],
        ctx: AdapterContext,
      ) => {
        const inner = botBrain({ label: s.brain, seat: s.seat, seed: ctx.seed, model: s.model });
        const brain: Brain = (req, n) => {
          if (s.seat === "p1" && req.meta.turn === 3 && req.meta.round === 0) {
            const text = readFileSync(join(dir, "match.jsonl"), "utf8");
            expect(text.endsWith("\n")).toBe(true);
            probe.lines = text
              .trimEnd()
              .split("\n")
              .map((row) => LogLineSchema.parse(JSON.parse(row)));
          }
          return inner(req, n);
        };
        return new FakeAdapter(spec, brain);
      };
      const run = await play(fakePlan({ days: 1 }), { dir, adapterFor });
      expect(run.outcome.status).toBe("ended");
      expect(run.outcome.paths.replies).toBe(join(dir, "replies.jsonl"));
      // Flushed line by line: the wake that opened p1's turn 3 is on disk before its model call.
      const onDisk = probe.lines ?? [];
      expect(onDisk.some((l) => l.k === "wake" && l.seat === "p1" && l.turn === 3)).toBe(true);
      expect(onDisk.at(-1)?.k).not.toBe("end");

      const replies = readFileSync(join(dir, "replies.jsonl"), "utf8")
        .trimEnd()
        .split("\n")
        .map((row) => ReplyLineSchema.parse(JSON.parse(row)));
      const kept = run.llm.filter((l) => l.stop === "end_turn" || l.stop === "tool_use");
      expect(replies.length).toBe(kept.length);
      for (const [i, r] of replies.entries()) {
        const l = kept[i];
        if (l === undefined) throw new Error(`no llm_call line for reply ${i}`);
        expect([r.seat, r.turn, r.round, r.attempt, r.kind, r.t, r.stop]).toEqual([
          l.seat,
          l.turn,
          l.round,
          l.attempt,
          l.kind,
          l.t,
          l.stop,
        ]);
        expect(r.reasoning.join("").length).toBe(l.reasoningChars);
        expect(r.text.join("").length).toBe(l.textChars);
        expect(r.calls.length).toBe(l.calls);
      }
      expect(replies.every((r) => r.reasoning[0]?.startsWith("Fake reasoning:") === true)).toBe(
        true,
      );
      expect(run.llm.every((l) => l.reasoningChars > 0)).toBe(true);
    },
    LONG,
  );
});

describe("arena: --stop-after and short matches", () => {
  xtest(
    "--stop-after 1 stops a 7-day match at the end of day 1: told 7 days, Level E up to the cut, exit 0",
    async () => {
      const run = await play(fakePlan({ stopAfterDays: 1 }));
      const { lines, llm, report } = run;
      expect([run.outcome.status, run.outcome.code]).toEqual(["stopped", 0]);
      expect(report.status).toBe("stopped");
      expect(report.reason).toBe(
        "stopped at the end of game day 1 (--stop-after; the match lasts 7 days)",
      );
      expect(report.days).toBe(7);
      expect(report.lastT).toBe(86_400);
      expect(report.endedAt).toBeNull();
      // The agents played the 7-day game: the shared block and the briefings say so.
      const shared = readFileSync(join(run.outcome.paths.dir, "prompts", "shared.txt"), "utf8");
      expect(shared).toContain("604800");
      expect(lines.some((l) => l.k === "end" || l.k === "fatal")).toBe(false);
      expect(Math.max(...lines.flatMap((l) => (l.k === "header" ? [] : [l.t])))).toBe(86_400);
      expect(llm.every((l) => l.t <= 86_400)).toBe(true);
      // Every checkpoint up to the cut verifies; only the end line is missing.
      expect(verifyLog(lines).divergence?.kind).toBe("end");
      expect(report.levelE).toMatchObject({ ok: true, divergence: null });
      expect(report.levelE?.checkpoints).toBeGreaterThanOrEqual(24);
      expect(rebuildGatewayState(lines, resolve).openTurns).toEqual([]);
      // One measured day, projected to the week.
      expect(report.projection).toMatchObject({ fromDays: 1, toDays: 7 });
      expect(report.projection.costNanoUsd).toBe(
        report.seats.reduce((n, s) => n + projectSpend(s.costNanoUsd, 1, 7), 0),
      );
      expect(run.stdout).toContain("Level E: ok up to the stop");
      expect(run.stderr).not.toContain("arena run:");
    },
    LONG,
  );

  test(
    "a one-hour match reports a fraction of a day: estimate and projection never from 0 or a whole day",
    async () => {
      const run = await play(fakePlan({ overrides: ["time.matchEnd=3600"] }));
      const r = run.report;
      expect(r.status).toBe("ended");
      expect(r.days).toBeCloseTo(1 / 24, 10);
      expect(r.estimate.central).toBeGreaterThan(0);
      expect(r.projection.fromDays).toBe(0.042);
      const spent = r.seats[0]?.costNanoUsd ?? 0;
      expect(spent).toBeGreaterThan(0);
      expect(r.seats[0]?.projectedNanoUsd).toBe(projectSpend(spent, 1 / 24, 7));
      expect(r.seats[0]?.projectedNanoUsd ?? 0).toBeGreaterThan(20 * projectSpend(spent, 1, 7));
    },
    LONG,
  );
});

describe("arena: determinism, hand-off, failures", () => {
  xtest(
    "two fake runs give identical match logs, LLM logs, reports and transcripts",
    async () => {
      const [a, b] = [await play(fakePlan({ days: 1 })), await play(fakePlan({ days: 1 }))];
      expect(harness.normalisedText(a.lines)).toBe(harness.normalisedText(b.lines));
      expect(a.calls).toEqual(b.calls);
      expect(a.report).toEqual(b.report);
      const t = (r: typeof a): string =>
        readFileSync(join(r.outcome.paths.dir, "transcripts", "p2", "t3.jsonl"), "utf8");
      expect(t(a)).toBe(t(b));
      expect(a.llm.every((l) => l.wallStart === undefined)).toBe(true);
    },
    LONG,
  );

  xtest(
    "a seat over its cap is handed to its profile's bot mid-match; no model call follows",
    async () => {
      const run = await play(fakePlan({ days: 2, seatCaps: ["p2=0.5"] }));
      const { lines, calls, llm, report } = run;
      const handoffs = calls.filter((l) => l.k === "handoff");
      expect(handoffs.map((h) => [h.seat, h.label, h.capNanoUsd])).toEqual([
        ["p2", "bot:conqueror@3", 500_000_000],
      ]);
      const controller = lines.find((l) => l.k === "controller");
      expect(controller?.k === "controller" ? [controller.seat, controller.label] : []).toEqual([
        "p2",
        "bot:conqueror@3",
      ]);
      const at = controller?.k === "controller" ? controller.t : -1;
      expect(at).toBeGreaterThan(0);
      expect(at).toBeLessThan(2 * 86400);
      // No model call after the hand-off; the seat's last call crossed the cap.
      expect(llm.filter((l) => l.seat === "p2").every((l) => l.t <= at)).toBe(true);
      const last = llm.findLast((l) => l.seat === "p2");
      expect(last?.seatSpentNanoUsd).toBeGreaterThanOrEqual(500_000_000);
      // The bot plays on: p2 has turns after the hand-off.
      expect(turns(lines).some((l) => l.seat === "p2" && l.t > at)).toBe(true);
      const p2 = report.seats.find((s) => s.seat === "p2");
      expect(p2?.handoff?.label).toBe("bot:conqueror@3");
      expect(p2?.handoff?.t).toBe(at);
      expect(p2?.controllers).toMatch(
        /^llm:fake\/claude-opus-5-5\/medium:achilles@1:p3 → bot:conqueror@3 at D[12] /,
      );
      expect(run.stderr).toContain("p2: over its cap");
      expect(verifyLog(lines).ok).toBe(true);
      expect(run.outcome.code).toBe(0);
    },
    LONG,
  );

  test(
    "a model error closes only its turn (deterministic error text); a 429 is retried; the match goes on",
    async () => {
      const run = await play(fakePlan({ days: 1 }), { adapterFor: wrapped(failing, "p2") });
      const p2 = turns(run.lines).filter((l) => l.seat === "p2");
      const t3 = p2.find((l) => l.turn === 3);
      expect([t3?.why, t3?.error]).toEqual([
        "error",
        "AgentError: llm p2 turn 3 round 0: bad_request (400)",
      ]);
      expect(p2.find((l) => l.turn === 4)?.why).not.toBe("error");
      expect(p2.find((l) => l.turn === 5)?.why).not.toBe("error");
      const r5 = run.llm.filter((l) => l.seat === "p2" && l.turn === 5 && l.round === 1);
      expect(r5.map((l) => [l.attempt, l.stop, l.error?.kind ?? null])).toEqual([
        [1, "error", "rate_limit"],
        [2, "tool_use", null],
      ]);
      const seat = run.report.seats.find((s) => s.seat === "p2");
      expect(seat?.errors).toEqual({ bad_request: 1, rate_limit: 1 });
      expect(run.outcome.status).toBe("ended");
      expect(verifyLog(run.lines).ok).toBe(true);
      expect(run.report.pauses).toEqual([]);
    },
    LONG,
  );

  xtest(
    "a billing error pauses a lockstep arena; the preflight probe resumes it; game time stood still",
    async () => {
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
          if (s.seat === "p1" && req.meta.turn === 3 && req.meta.round === 0 && !fired) {
            fired = true;
            down = true;
            return billing();
          }
          return inner(req, n);
        };
        return new FlakyAdapter(
          spec,
          brain,
          () => {
            if (!down) return null;
            probes += 1;
            if (probes < 3) return billing();
            down = false;
            return null;
          },
          // Each passing preflight reads 1 000 prefix tokens from the cache ($0.0002 on Opus 5.5).
          [
            {
              model: s.model,
              kind: "message",
              tokens: { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 1000, output: 0 },
              estimated: false,
            },
          ],
        );
      };
      const run = await play(fakePlan({ days: 1 }), { adapterFor, probeEveryMs: 60_000 });
      expect(run.outcome.status).toBe("ended");
      expect(run.report.pauses.map((p) => [p.outcome, p.seat, p.pausedMs])).toEqual([
        ["resumed", "p1", 180_000],
      ]);
      expect(run.report.pauses[0]?.reason).toContain("billing: credit balance too low");
      const r0 = run.llm.filter((l) => l.seat === "p1" && l.turn === 3 && l.round === 0);
      expect(r0.map((l) => [l.attempt, l.error?.kind ?? null])).toEqual([
        [1, "billing"],
        [2, null],
      ]);
      // Game time stood still: both attempts were built at the same game second.
      expect(new Set(r0.map((l) => l.t)).size).toBe(1);
      expect(turns(run.lines).find((l) => l.seat === "p1" && l.turn === 3)?.why).not.toBe("error");
      expect(run.stderr).toContain("ALERT: the arena is paused: billing");
      // The preflight and the probe that passed are both accounted (failed probes bill nothing).
      expect(run.report.totals.preflightNanoUsd).toBe(2 * 1000 * 200);
      expect(verifyLog(run.lines).ok).toBe(true);
    },
    LONG,
  );

  test(
    "a pause longer than --pause-max aborts: the aborted second's turns close, the log is cut, exit 2",
    async () => {
      let down = false;
      const adapterFor = (
        s: LlmSeatPlan,
        spec: ConstructorParameters<typeof FakeAdapter>[0],
        ctx: AdapterContext,
      ) => {
        const inner = botBrain({ label: s.brain, seat: s.seat, seed: ctx.seed, model: s.model });
        const brain: Brain = (req, n) => {
          if (s.seat === "p3" && req.meta.turn === 4) down = true;
          return down ? billing() : inner(req, n);
        };
        return new FlakyAdapter(spec, brain, () => (down ? billing() : null));
      };
      const run = await play(fakePlan({ days: 1, pauseMaxMs: 10 * 60_000 }), {
        adapterFor,
        probeEveryMs: 60_000,
      });
      const { lines, report } = run;
      expect(run.outcome.code).toBe(2);
      expect(run.outcome.status).toBe("aborted");
      expect(report.status).toBe("aborted");
      expect(report.reason).toContain("arena aborted (paused for more than 600000 ms): billing");
      expect(report.pauses.map((p) => [p.outcome, p.seat, p.pausedMs])).toEqual([
        ["aborted", "p3", 600_000],
      ]);
      // The log stops without an end line or a fatal line, and every turn it opened is closed.
      expect(lines.some((l) => l.k === "end" || l.k === "fatal")).toBe(false);
      const p3 = turns(lines).filter((l) => l.seat === "p3");
      const closed = p3.find((l) => l.turn === 4);
      expect(closed?.why).toBe("error");
      expect(closed?.error).toContain("arena aborted");
      const lastT = Math.max(...lines.flatMap((l) => (l.k === "header" ? [] : [l.t])));
      expect(closed?.t).toBe(lastT);
      const rebuilt = rebuildGatewayState(lines, resolve);
      expect(rebuilt.openTurns).toEqual([]);
      expect(rebuilt.drift).toBeNull();
      // Level E holds up to the cut: the only divergence is the missing end line.
      const e = verifyLog(lines);
      expect(e.divergence?.kind).toBe("end");
      expect(e.divergence?.actual).toContain("the log stops");
      expect(report.levelE?.ok).toBe(false);
      const summary: unknown = JSON.parse(
        readFileSync(join(run.outcome.paths.dir, "summary.json"), "utf8"),
      );
      expect(summary).toMatchObject({ status: "incomplete" });
      expect(run.stderr).toContain("ALERT: arena aborted");
    },
    LONG,
  );

  test(
    "a breaker the preflight cannot reproduce (a 400 from round 1 on) trips again after its resume: abort, exit 2",
    async () => {
      const run = await play(fakePlan({ days: 2 }), {
        adapterFor: wrapped(round1),
        probeEveryMs: 60_000,
      });
      expect([run.outcome.status, run.outcome.code]).toEqual(["aborted", 2]);
      expect(run.report.reason).toContain(
        "the breaker tripped again before any LLM turn closed cleanly since its last resume: the cause persists",
      );
      expect(run.report.pauses.map((p) => p.outcome)).toEqual(["resumed", "aborted"]);
      // Stopped within the first game hour, not played on for two days with dead LLM seats.
      expect(run.report.lastT).toBeLessThan(3600);
      expect(run.stderr).toContain("it cannot replay the failing request");
    },
    LONG,
  );

  xtest(
    "two consecutive refused turns of a seat raise an alert with their inbox message ids",
    async () => {
      const run = await play(fakePlan({ days: 1 }), { adapterFor: wrapped(refusing, "p1") });
      const refused = run.llm.filter((l) => l.stop === "refusal");
      expect(refused.map((l) => [l.seat, l.turn])).toEqual([
        ["p1", 2],
        ["p1", 3],
      ]);
      expect(refused.every((l) => Array.isArray(l.inbox))).toBe(true);
      const alerts = run.report.alerts.filter((a) => a.includes("consecutive turns refused"));
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatch(
        /^p1: 2 consecutive turns refused \(2, 3\); a player's message may be the cause \(refusal-DoS\): their inbox (was empty|held g[0-9a-z]+(, g[0-9a-z]+)*)$/,
      );
      // Refusals close their turns but do not trip the breaker.
      expect(run.report.pauses).toEqual([]);
      expect(run.outcome.status).toBe("ended");
    },
    LONG,
  );

  test(
    "a match whose LLM turns mostly close by an error is degraded (exit 2), even with no breaker trip",
    async () => {
      const run = await play(fakePlan({ days: 1 }), { adapterFor: wrapped(refuseAll) });
      expect([run.outcome.status, run.outcome.code]).toEqual(["degraded", 2]);
      expect(run.report.reason).toMatch(/^\d+ of \d+ LLM turns \(\d+%\) closed by an error/);
      expect(run.report.pauses).toEqual([]);
      expect(run.report.alerts.some((a) => a.startsWith("degraded run:"))).toBe(true);
      expect(run.report.levelE?.ok).toBe(true);
    },
    LONG,
  );
});
