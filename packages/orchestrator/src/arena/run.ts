import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifyLog } from "@perfidia/engine";
import { canonicalJson, fmtTime, sha256Hex } from "@perfidia/engine/core";
import {
  runMatch,
  type LogSink,
  type RunMatchOptions,
  type RunResult,
} from "@perfidia/gateway/runtime";
import type { LogLine, PlayerId, RoundInput, SeatAgent, TimeSource } from "@perfidia/protocol";
import {
  EXIT,
  RunDirSink,
  errorText,
  harness,
  readLogLines,
  summarize,
  writeFileAtomic,
  type CliIo,
  type ExitCode,
} from "@perfidia/sim";
import { BudgetLedger, MatchBudget, type KillNote } from "../budget/ledger.ts";
import { FileCallLog, writePrompts, type CallLog } from "../log/calls.ts";
import {
  EstimateFileSchema,
  SeatsFileSchema,
  type ArenaReport,
  type ArenaStatus,
  type LlmLogLine,
  type SeatsFile,
} from "../log/schema.ts";
import { watchFold } from "../log/watch.ts";
import { promptTokens, type ModelAdapter, type ModelSpec } from "../model/adapter.ts";
import { AnthropicAdapter, AnthropicClient, type HttpFetch } from "../model/anthropic.ts";
import { seededRandom, type HarnessClock } from "../model/clock.ts";
import { FakeAdapter } from "../model/fake.ts";
import { formatCents, formatUsd } from "../model/prices.ts";
import { RateGates } from "../model/rate.ts";
import { LlmSeatAgent } from "../seat/agent.ts";
import { ArenaPauseGate, type ArenaAborted, type PauseReason } from "../seat/pause.ts";
import { PROMPT_VERSION, operatorTemplates, seatPrompt } from "../seat/prompt.ts";
import { botBrain } from "./brain.ts";
import { estimateSeat, projectSpend } from "./cost.ts";
import { reserveText } from "./estimate.ts";
import {
  PreflightError,
  groupKey,
  groupsOf,
  preflight,
  type GroupOutcome,
  type PreflightGroup,
} from "./preflight.ts";
import {
  DEFAULT_ARENA_DAYS,
  llmSeatsOf,
  matchEndOf,
  type ArenaPlan,
  type LlmSeatPlan,
} from "./plan.ts";
import {
  HARNESS_VERSION,
  STOPPED,
  buildReport,
  formatReport,
  turnErrors,
  type DayRow,
  type LevelE,
} from "./report.ts";

// `arena run` (phase-2 design §1.4, §6): builds the agents (LLM seats on the Anthropic adapter, or
// on the bot-backed fake with `--fake`; bots through the sim harness), runs the preflight before
// anything is written, then runs the match through the gateway's `runMatch` into a run directory:
//
//   match.jsonl, snapshots/, summary.json   as `sim run` writes them (Level E checked at the end);
//                                           match.jsonl flushed after every line, so a reader
//                                           tailing it (the spectator server) sees each line at once
//   llm_calls.jsonl, transcripts/, prompts/ the LLM logs (§5.1, §4.5)
//   replies.jsonl                           every reply that arrived: reasoning, text, calls (phase 3)
//   seats.json                              who played what, with the prompt hashes
//   feed.txt                                the `--watch` text of the whole match (a fold of match.jsonl)
//   arena.json                              the report (§6), rewritten at each status change
//
// Systematic API failures close the arena pause gate (§2.6): in lockstep the next LLM round waits
// and a probe (the preflight) reopens it, and after `--pause-max` the arena aborts; in real time an
// operator-recoverable failure aborts at once and a tripped breaker is an alert. A breaker that
// trips again before any LLM turn closed cleanly since its resume (or alert) aborts the arena. An
// abort lets the game second it happened in finish (every LLM round of it is refused, so each open
// turn closes with `why: "error"`), then cuts the log at the first line of a later second: the
// host's write fails and the driver stops. `match.jsonl` ends without an end line, the summary
// says `incomplete`, and the exit code is 2. In lockstep no turn is left open; in real time a bot
// still thinking at the cut keeps its turn open (the gateway rebuild lists it).
//
// `--stop-after N` cuts the log the same way at the end of game day N (status `stopped`, exit 0
// when Level E holds up to the cut): the agents play the full-length match they were told about,
// and no LLM round is called past the cut. A run that ends or stops with at least
// `DEGRADED_ERROR_PCT` of its LLM turns closed by an error is `degraded` (exit 2), and two
// consecutive refused turns of a seat are an alert naming the turns' inbox message ids (§3.8).
//
// Phase 4 (Pass 1a, docs/phase4.md): every dollar is on a line of `llm_calls.jsonl` (the start
// preflight's `preflight` lines are buffered until the run directory exists, failed groups
// included; probes write theirs), and counts toward the match budget when the run has one.
// `estimate.json` is written once, before turn 1, and its sha256 goes into `seats.json`. The kill
// switch (spend reaching `K = budget − reserve`) halts every LLM seat: no attempt starts after it,
// each seat is handed to its bot (`match_budget`) and the match plays on to its end, or, with
// `--on-budget abort`, the run aborts. Probes stop once no LLM seat can call its model. An operator
// signal (SIGINT or SIGTERM) once hands every LLM seat to its bot (`operator`); twice aborts.

export const ARENA_FILE = "arena.json";
export const SEATS_FILE = "seats.json";
export const FEED_FILE = "feed.txt";
export const CALLS_FILE = "llm_calls.jsonl";
export const REPLIES_FILE = "replies.jsonl";
export const ESTIMATE_FILE = "estimate.json";

export interface ArenaPaths {
  readonly dir: string;
  readonly log: string;
  readonly calls: string;
  readonly replies: string;
  readonly arena: string;
  readonly seats: string;
  readonly feed: string;
  readonly summary: string;
  readonly estimate: string;
}

export function arenaPaths(dir: string): ArenaPaths {
  return {
    dir,
    log: join(dir, "match.jsonl"),
    calls: join(dir, CALLS_FILE),
    replies: join(dir, REPLIES_FILE),
    arena: join(dir, ARENA_FILE),
    seats: join(dir, SEATS_FILE),
    feed: join(dir, FEED_FILE),
    summary: join(dir, "summary.json"),
    estimate: join(dir, ESTIMATE_FILE),
  };
}

/** Operator signals (SIGINT, SIGTERM): the CLI subscribes the process's, tests their own. */
export interface SignalSource {
  /** Calls `handler` with the signal's name on each signal; returns the unsubscribe. */
  subscribe(handler: (signal: string) => void): () => void;
}

/** What an adapter factory gets besides the seat's plan and spec. */
export interface AdapterContext {
  readonly time: TimeSource;
  readonly seed: number;
}

export interface RunArenaOptions {
  readonly dir: string;
  readonly io: CliIo;
  /** Builds an LLM seat's adapter instead of the plan's (tests: scripted brains, failures). */
  readonly adapterFor?: (seat: LlmSeatPlan, spec: ModelSpec, ctx: AdapterContext) => ModelAdapter;
  /** The Anthropic client's `fetch` (tests: a stub). */
  readonly fetch?: HttpFetch;
  /** How often a closed pause gate re-runs the preflight; default 2 minutes. */
  readonly probeEveryMs?: number;
  /** `--fake` in real time: the fake models' think time (default: the bots' latency). */
  readonly brainLatencyMs?: readonly [number, number];
  /** Print nothing but alerts. */
  readonly quiet?: boolean;
  /** Operator signals: once hands every LLM seat to its bot, twice aborts (phase 4). */
  readonly signals?: SignalSource;
}

export interface ArenaOutcome {
  readonly code: ExitCode;
  readonly status: ArenaStatus;
  readonly report: ArenaReport;
  readonly paths: ArenaPaths;
  readonly error: string | null;
  /** The gateway's result (null after a stop). */
  readonly result: RunResult | null;
}

/** The host's writes after an abort: the log is cut there. */
class ArenaCut extends Error {
  override readonly name = "ArenaCut";
}

const shortName = (name: string): string => name.split(",")[0] ?? name;

function levelEOf(path: string): LevelE {
  const report = verifyLog(readLogLines(path));
  const d = report.divergence;
  return {
    ok: report.ok,
    actions: report.actions,
    checkpoints: report.checkpoints,
    divergence:
      d === undefined ? null : `${d.kind} at t = ${d.t}: expected ${d.expected}; got ${d.actual}`,
  };
}

/** The game time an LLM round is built on (the latest of its briefing and results). */
function roundTime(input: RoundInput): number {
  let t = input.briefing.t;
  for (const r of input.results) if (r.t > t) t = r.t;
  return t;
}

/** `agent` with no model call past `stopAt`: those rounds are cut from the log anyway. */
function stopping(agent: SeatAgent, stopAt: number | null): SeatAgent {
  if (stopAt === null) return agent;
  return {
    label: agent.label,
    round: (input) =>
      roundTime(input) > stopAt ? Promise.resolve({ calls: [] }) : agent.round(input),
  };
}

const pauseText = (r: PauseReason): string =>
  `${r.kind}: ${r.message}${r.seat === null ? "" : ` (${r.seat}${r.model === null ? "" : `, ${r.model}`})`}`;

/** `--on-budget abort`: the kill switch aborts the run. */
function abortForBudget(g: ArenaPauseGate, k: KillNote): void {
  g.abort(
    {
      kind: "budget",
      message: `spent ${formatUsd(k.spentNanoUsd)} reached the kill threshold ${formatUsd(k.killAtNanoUsd)}`,
      seat: null,
      model: null,
    },
    "the match budget's kill switch fired (--on-budget abort)",
  );
}

/** Runs a planned arena match into `o.dir` (which must not hold a run). */
export async function runArena(plan: ArenaPlan, o: RunArenaOptions): Promise<ArenaOutcome> {
  const io = o.io;
  const say = (text: string): void => {
    if (o.quiet !== true) io.out(text);
  };
  const setup = plan.setup;
  const seed = setup.seed;
  const llm = llmSeatsOf(plan);
  const { shared, tools } = plan.texts;

  const virtual = plan.time === "virtual" ? harness.createVirtualTime() : null;
  const time: TimeSource = virtual ?? new harness.SystemTime();
  const iso = (): string =>
    virtual === null ? new Date().toISOString() : `+${String(time.nowMs())}ms`;
  const clock: HarnessClock =
    virtual === null
      ? {
          time,
          random: plan.fake ? seededRandom(seed) : Math.random,
          iso: () => new Date().toISOString(),
        }
      : { time, random: seededRandom(seed) };
  const think =
    plan.clock.kind === "realtime" ? { time, latencyMs: plan.clock.botLatencyMs } : undefined;
  const wall: { start: string; end: string | null } = { start: iso(), end: null };

  // The LLM log: buffered until the run directory exists (the start preflight comes first).
  let calls: FileCallLog | null = null;
  const early: LlmLogLine[] = [];
  const llmLines: LlmLogLine[] = [];
  /** Per seat, the last turn closed by a refusal, its inbox, and the streak it ends. */
  const refused = new Map<PlayerId, { turn: number; inbox: readonly string[]; streak: number }>();
  const alerts: string[] = [];
  const alert = (text: string): void => {
    alerts.push(text);
    io.err(`ALERT: ${text}\n`);
  };
  const log: CallLog = {
    write(line) {
      if (calls === null) early.push(line);
      else calls.write(line);
      llmLines.push(line);
      if (line.k === "llm_call") {
        if (line.fallback) {
          io.err(
            `${line.seat} turn ${line.turn}: served by the fallback model ${line.servedBy ?? "?"} (requested ${line.model})\n`,
          );
        }
        if (line.stop === "refusal") {
          const inbox = line.inbox ?? [];
          io.err(
            `${line.seat} turn ${line.turn}: refusal (${line.refusal?.category ?? "uncategorised"}) on ${line.servedBy ?? line.model}; inbox ${inbox.length === 0 ? "empty" : inbox.join(", ")}\n`,
          );
          // A refused round closes its turn (a refused thought call does not).
          const prev = refused.get(line.seat);
          if (line.kind === "round" && prev?.turn !== line.turn) {
            const streak = prev?.turn === line.turn - 1 ? prev.streak + 1 : 1;
            refused.set(line.seat, { turn: line.turn, inbox, streak });
            if (streak === 2) {
              const ids = [...new Set([...(prev?.inbox ?? []), ...inbox])];
              alert(
                `${line.seat}: 2 consecutive turns refused (${line.turn - 1}, ${line.turn}); a player's message may be the cause (refusal-DoS): their inbox ${ids.length === 0 ? "was empty" : `held ${ids.join(", ")}`}`,
              );
            }
          }
        }
      } else if (line.k === "handoff") {
        const why =
          line.reason === "cap"
            ? `over its cap (${formatUsd(line.spentNanoUsd)} of ${formatUsd(line.capNanoUsd)})`
            : line.reason === "match_budget"
              ? "the match budget's kill switch fired"
              : line.reason === "operator"
                ? "the operator stopped the LLM seats"
                : line.reason;
        io.err(`${line.seat}: ${why}: handed to ${line.label} at its next turn\n`);
      } else if (line.k === "wake_cap") {
        io.err(
          `${line.seat} turn ${line.turn}: wake cap reached (${formatUsd(line.wakeSpentNanoUsd)}): the turn ends\n`,
        );
      } else if (line.k === "prompt_cap") {
        io.err(
          `${line.seat} turn ${line.turn}: prompt cap (an estimated ${line.estimateTokens} tokens > ${line.capTokens}): the ${line.kind === "round" ? "turn closes" : "thought call is skipped"}\n`,
        );
      }
    },
    reply(line) {
      calls?.reply(line);
    },
    transcript(record) {
      calls?.transcript(record);
    },
  };

  /** The last game time of the log (probes and signals are dated with it). */
  let lastT = 0;
  // The gate exists once the run directory does; a kill before it (the start preflight) is acted
  // on when it is built.
  let gateRef: ArenaPauseGate | null = null;
  let killAbort = false;
  const onKill = (k: KillNote): void => {
    const action = plan.budget?.onBudget ?? "handoff";
    log.write({
      k: "kill_switch",
      t: k.t,
      ...(virtual === null ? { wall: iso() } : {}),
      spentNanoUsd: k.spentNanoUsd,
      killAtNanoUsd: k.killAtNanoUsd,
      budgetNanoUsd: k.budgetNanoUsd,
      action,
    });
    alert(
      `the match budget's kill switch fired: ${formatUsd(k.spentNanoUsd)} spent reached K = ${formatUsd(k.killAtNanoUsd)} (budget ${formatUsd(k.budgetNanoUsd)}); no model attempt starts from now on, ${action === "abort" ? "and the run aborts (--on-budget abort)" : "every LLM seat is handed to its bot at its next turn and the match plays on"}`,
    );
    if (action === "abort") {
      if (gateRef === null) killAbort = true;
      else abortForBudget(gateRef, k);
    }
  };
  const budget =
    plan.budget === null
      ? null
      : new MatchBudget({
          budgetNanoUsd: plan.budget.budgetNanoUsd,
          reserveNanoUsd: plan.prediction.reserve.reserveNanoUsd,
          carryNanoUsd: plan.budget.carryNanoUsd,
          onKill,
        });
  if (plan.budget !== null && plan.budget.carryFrom !== null) {
    log.write({
      k: "carry",
      from: plan.budget.carryFrom,
      lines: plan.budget.carryLines,
      costNanoUsd: plan.budget.carryNanoUsd,
    });
  }

  // Adapters and the preflight, before anything is written.
  let client: AnthropicClient | null = null;
  const anthropic = (): AnthropicClient => {
    if (client !== null) return client;
    if (plan.env.apiKey === null) throw new Error("no API key: the plan should have refused");
    client = new AnthropicClient({
      apiKey: plan.env.apiKey,
      baseURL: plan.baseURL,
      ...(o.fetch === undefined ? {} : { fetch: o.fetch }),
    });
    return client;
  };
  const prompts = new Map<PlayerId, string>();
  const adapters = new Map<PlayerId, ModelAdapter>();
  for (const s of llm) {
    prompts.set(s.seat, seatPrompt(s.seat, s.profile));
    const spec: ModelSpec = {
      provider: plan.fake ? "fake" : s.provider,
      model: s.model,
      effort: s.effort,
      maxOutputTokens: plan.maxTokens,
      cacheTtl: plan.cacheTtl,
      fallbacks: s.fallbacks,
    };
    const latency =
      plan.clock.kind === "realtime"
        ? { time, rangeMs: o.brainLatencyMs ?? plan.clock.botLatencyMs }
        : undefined;
    adapters.set(
      s.seat,
      o.adapterFor?.(s, spec, { time, seed }) ??
        (plan.fake
          ? new FakeAdapter(
              spec,
              botBrain({
                label: s.brain,
                seat: s.seat,
                seed,
                model: s.model,
                maxOutputTokens: plan.maxTokens,
                prefixChars:
                  shared.length + (prompts.get(s.seat) ?? "").length + JSON.stringify(tools).length,
                ...(latency === undefined ? {} : { latency }),
              }),
            )
          : new AnthropicAdapter(spec, anthropic())),
    );
  }
  const groups = groupsOf(
    llm.map((s): PreflightGroup => ({
      seat: s.seat,
      adapter: adapters.get(s.seat) ?? missing(s.seat),
      prompt: { shared, seat: prompts.get(s.seat) ?? "" },
      tools,
    })),
  );
  /** Charges one group's check to the budget and writes its `preflight` line. */
  const preflightLine =
    (phase: "start" | "probe") =>
    (g: GroupOutcome): void => {
      const spec = g.group.adapter.spec;
      const t = phase === "start" ? 0 : lastT;
      log.write({
        k: "preflight",
        phase,
        group: g.group.adapter.label,
        provider: spec.provider,
        model: spec.model,
        endpoint: null,
        t,
        ok: g.ok,
        usage: g.usage.map((u) => ({
          model: u.model,
          kind: u.kind,
          input: u.tokens.input,
          cacheWrite5m: u.tokens.cacheWrite5m,
          cacheWrite1h: u.tokens.cacheWrite1h,
          cacheRead: u.tokens.cacheRead,
          output: u.tokens.output,
          estimated: u.estimated,
        })),
        costNanoUsd: g.nanoUsd,
        priceCard: g.cards[0] ?? null,
        error: g.error,
        ...(virtual === null ? { wallStart: iso() } : {}),
      });
      budget?.add(g.nanoUsd, t);
    };
  const pre = await preflight(groups, { onGroup: preflightLine("start") }).catch((e: unknown) => {
    const spent = early.reduce((n, l) => n + (l.k === "preflight" ? l.costNanoUsd : 0), 0);
    if (e instanceof PreflightError && spent > 0) {
      io.err(
        `the start preflight spent ${formatUsd(spent)} before it failed (nothing is written: this is its only record)\n`,
      );
    }
    throw e;
  });
  /** Per preflight group, the measured prompt of its shape check: an upper bound of its prefix. */
  const measured = new Map<string, { tokens: number; seatBytes: number }>();
  for (const g of pre.groups) {
    const last = g.usage.at(-1);
    if (last !== undefined) {
      measured.set(groupKey(g.group.adapter), {
        tokens: promptTokens(last.tokens),
        seatBytes: new TextEncoder().encode(g.group.prompt.seat).length,
      });
    }
  }
  for (const r of pre.reports) {
    say(
      `preflight ${r.model}: ok${r.allowedFallbackModels.length === 0 ? "" : `, fallbacks ${r.allowedFallbackModels.join(", ")}`}\n`,
    );
  }

  // The run directory.
  const files = new RunDirSink(o.dir, { flush: "line" });
  const paths = arenaPaths(o.dir);
  calls = new FileCallLog(o.dir, { transcripts: plan.transcripts });
  for (const line of early.splice(0)) calls.write(line);
  const operator = operatorTemplates();
  writePrompts(o.dir, {
    shared,
    seats: Object.fromEntries(prompts),
    operator,
    tools,
  });
  // The prediction, once, before turn 1 (§5.1): its sha256 goes into seats.json.
  const estimateText = `${JSON.stringify(EstimateFileSchema.parse(plan.estimate), null, 2)}\n`;
  writeFileSync(paths.estimate, estimateText, { flag: "wx" });
  const estimateSha256 = sha256Hex(estimateText);
  const agentLabels = new Map<PlayerId, string>();

  // Status, pauses and alerts.
  const days: DayRow[] = [];
  let status: ArenaStatus = "running";
  let reason: string | null = null;
  const report = (levelE: LevelE | null): ArenaReport =>
    buildReport({
      plan,
      status,
      reason,
      lines: [...readLogLines(paths.log)],
      calls: llmLines,
      alerts,
      days,
      levelE,
      estimate: { file: plan.estimate, sha256: estimateSha256 },
      wall,
    });
  const writeReport = (r: ArenaReport): void =>
    writeFileAtomic(paths.arena, `${JSON.stringify(r, null, 2)}\n`);

  /** After an abort: the last game second the log may still hold. */
  let cutAfter: number | null = null;
  const stop: { aborted: ArenaAborted | null } = { aborted: null };
  const alerted = new Set<string>();
  let pauseStart: { readonly wall: string; readonly ms: number } | null = null;
  const pauseLine = (r: PauseReason, outcome: "resumed" | "aborted", pausedMs: number) =>
    log.write({
      k: "pause",
      wallStart: pauseStart?.wall ?? iso(),
      wallEnd: iso(),
      reason: pauseText(r),
      seat: r.seat,
      model: r.model,
      outcome,
      pausedMs: Math.max(0, Math.floor(pausedMs)),
    });

  const rates = new RateGates({ clock, maxInflight: plan.maxInflight });
  const seatPlanOf = (seat: PlayerId): LlmSeatPlan =>
    llm.find((s) => s.seat === seat) ?? missing(seat);
  const ledger = new BudgetLedger({
    caps: new Map(llm.map((s) => [s.seat, s.capNanoUsd])),
    wakeCapNanoUsd: plan.wakeCapNanoUsd,
    wakeCaps: new Map(llm.map((s) => [s.seat, s.wakeCapNanoUsd])),
    handoffTo: (seat) => {
      const label = seatPlanOf(seat).handoffBot;
      return { label, agent: harness.agentFromLabel(label, seat, seed, think) };
    },
    onHandoff: (n) =>
      log.write({
        k: "handoff",
        seat: n.seat,
        t: n.t,
        reason: n.reason,
        label: n.label,
        spentNanoUsd: n.spentNanoUsd,
        capNanoUsd: n.capNanoUsd,
      }),
    ...(budget === null ? {} : { match: budget }),
  });

  const gate = new ArenaPauseGate({
    clock,
    mode: plan.clock.kind === "lockstep" ? "wait" : "abort",
    probe: async () => {
      // No LLM seat can call its model any more (the kill switch, the operator, every seat over
      // its cap): reopen without probing, so the waiting seats reach their hand-offs.
      if (ledger.halted !== null || ledger.allHandedOff()) return true;
      try {
        // Charged and logged group by group; it stops between groups once the seats are halted.
        await preflight(groups, {
          onGroup: preflightLine("probe"),
          stop: () => ledger.halted !== null,
        });
        return true;
      } catch {
        return false;
      }
    },
    ...(o.probeEveryMs === undefined ? {} : { probeEveryMs: o.probeEveryMs }),
    pauseMaxMs: plan.pauseMaxMs,
    onPause: (r) => {
      pauseStart = { wall: iso(), ms: time.nowMs() };
      status = "paused";
      reason = pauseText(r);
      const every = Math.round((o.probeEveryMs ?? 120_000) / 1000);
      const resume =
        r.kind === "breaker"
          ? `the preflight is re-run every ${every} s and resumes the arena when it passes, but it cannot replay the failing request: if the breaker trips again before an LLM turn closes cleanly, the arena aborts`
          : `fix the cause: the preflight is re-run every ${every} s and resumes the arena when it passes`;
      alert(
        `the arena is paused: ${pauseText(r)}. The next LLM round waits at the gate (game time stands still from there; the bots play until then); ${resume}; it aborts after ${Math.round(plan.pauseMaxMs / 60_000)} min of pause in total`,
      );
      files.flush();
      writeReport(report(null));
    },
    onResume: (r, pausedMs) => {
      pauseLine(r, "resumed", pausedMs);
      pauseStart = null;
      status = "running";
      reason = null;
      io.err(`resumed after ${Math.round(pausedMs / 1000)} s of pause (${pauseText(r)})\n`);
      files.flush();
      writeReport(report(null));
    },
    onAbort: (e) => {
      stop.aborted = e;
      files.flush();
      cutAfter = lastT;
      if (e.reason.kind !== "budget" && e.reason.kind !== "operator") {
        pauseLine(e.reason, "aborted", pauseStart === null ? 0 : time.nowMs() - pauseStart.ms);
      }
      alert(e.message);
    },
    onAlert: (r) =>
      alert(
        `${pauseText(r)} (real time cannot pause: the failing LLM turns close on their own; if the breaker trips again before an LLM turn closes cleanly, the arena aborts)`,
      ),
  });
  gateRef = gate;
  const earlyKill = budget?.killNote ?? null;
  if (killAbort && earlyKill !== null) abortForBudget(gate, earlyKill);

  const agents = new Map<PlayerId, SeatAgent>();
  const utf8 = new TextEncoder();
  for (const s of plan.seats) {
    if (s.kind === "bot") {
      agents.set(s.seat, harness.agentFromLabel(s.label, s.seat, seed, think));
      agentLabels.set(s.seat, s.label);
      continue;
    }
    const adapter = adapters.get(s.seat) ?? missing(s.seat);
    const seatText = prompts.get(s.seat) ?? "";
    // The measured prefix of the seat's group, adjusted for its own seat block's length.
    const m = measured.get(groupKey(adapter));
    const prefixTokens =
      m === undefined
        ? undefined
        : m.tokens + Math.max(0, utf8.encode(seatText).length - m.seatBytes);
    const agent = new LlmSeatAgent({
      seat: s.seat,
      adapter,
      prompt: { shared, seat: seatText },
      tools,
      profile: s.profile,
      ledger,
      log,
      clock,
      gate,
      rate: rates.gate(adapter.spec.provider, adapter.spec.model),
      policy: plan.policy,
      ...(prefixTokens === undefined ? {} : { prefixTokens }),
    });
    agents.set(s.seat, stopping(agent, plan.stopAt));
    agentLabels.set(s.seat, agent.label);
  }

  const seatsFile: SeatsFile = SeatsFileSchema.parse({
    harness: HARNESS_VERSION,
    promptVersion: PROMPT_VERSION,
    prompts: {
      shared: sha256Hex(shared),
      operator: sha256Hex(canonicalJson(operator)),
      tools: sha256Hex(canonicalJson(tools)),
    },
    ...(plan.lineup === null ? {} : { lineup: plan.lineup }),
    estimateSha256,
    promptCapTokens: plan.promptCapTokens,
    ...(plan.budget === null ? {} : { budgetNanoUsd: plan.budget.budgetNanoUsd }),
    seats: plan.seats.map((s) =>
      s.kind === "bot"
        ? { seat: s.seat, kind: "bot", label: s.label }
        : {
            seat: s.seat,
            kind: "llm",
            label: agentLabels.get(s.seat) ?? "",
            provider: plan.fake ? "fake" : s.provider,
            model: s.model,
            effort: s.effort,
            maxTokens: plan.maxTokens,
            capNanoUsd: s.capNanoUsd,
            profile: { ...s.profile },
            handoffBot: s.handoffBot,
            prompt: sha256Hex(prompts.get(s.seat) ?? ""),
            fallbacks: s.fallbacks,
          },
    ),
  });
  writeFileSync(paths.seats, `${JSON.stringify(seatsFile, null, 2)}\n`);

  // The plan, then the prediction and the budget (§5.3).
  const matchDays = matchEndOf(plan) / 86_400;
  const stopText = plan.stopAt === null ? "" : `, stopping after day ${plan.stopAt / 86_400}`;
  say(
    `arena: ${plan.setup.ruleset}, seed ${seed}, ${setup.seats.length} players, ${matchDays} day(s)${stopText}, ${plan.clock.kind}${plan.fake ? ", fake models ($0)" : ""}${plan.lineup === null ? "" : `, lineup ${plan.lineup}`}\n`,
  );
  const predicted = new Map(plan.prediction.seats.map((p) => [p.seat, p]));
  for (const s of plan.seats) {
    if (s.kind === "bot") say(`  ${s.seat}  ${s.label}\n`);
    else {
      const est = predicted.get(s.seat);
      say(
        `  ${s.seat}  ${agentLabels.get(s.seat) ?? ""}  cap ${formatUsd(s.capNanoUsd)}  estimate ${formatUsd(est?.central ?? 0)} (${formatUsd(est?.low ?? 0)}–${formatUsd(est?.high ?? 0)})${plan.fake ? ` [plays ${s.brain}]` : ""}\n`,
      );
    }
  }
  const e = plan.estimate;
  say(
    `prediction for ${e.days} game day(s) (${e.match.source}): ${formatCents(e.match.low)} low · ${formatCents(e.match.central)} central · ${formatCents(e.match.high)} high; reserve ${reserveText(e.reserve)}${e.budget === null ? "; no match budget" : `; budget ${formatCents(e.budget.budgetNanoUsd)}, kill threshold K = ${formatCents(e.budget.killAtNanoUsd)}`}\n`,
  );
  for (const w of plan.warnings) alert(w);
  writeReport(report(null));

  // Operator signals: once hands every LLM seat to its bot, twice aborts.
  let signals = 0;
  const unsubscribe = o.signals?.subscribe((signal) => {
    signals += 1;
    if (signals === 1) {
      log.write({
        k: "operator",
        signal,
        action: "handoff",
        t: lastT,
        ...(virtual === null ? { wall: iso() } : {}),
      });
      alert(
        `${signal}: no model attempt starts from now on; every LLM seat is handed to its bot at its next turn and the match plays on (send it again to abort)`,
      );
      ledger.halt("operator", lastT);
      return;
    }
    if (signals === 2) {
      log.write({
        k: "operator",
        signal,
        action: "abort",
        t: lastT,
        ...(virtual === null ? { wall: iso() } : {}),
      });
      gate.abort(
        { kind: "operator", message: `${signal} received twice`, seat: null, model: null },
        "the operator sent a second signal",
      );
    }
  });

  // The daily tripwire (§5.3, item 8): spend per seat at every game-day boundary.
  const spentAt = new Map<PlayerId, number>(llm.map((s) => [s.seat, 0]));
  const toDays = Math.max(DEFAULT_ARENA_DAYS, matchDays);
  const dayBoundary = (day: number): void => {
    const parts: string[] = [];
    for (const s of llm) {
      const spent = ledger.spent(s.seat);
      const dayNano = spent - (spentAt.get(s.seat) ?? 0);
      spentAt.set(s.seat, spent);
      const projected = projectSpend(spent, day, toDays);
      days.push({
        day,
        seat: s.seat,
        dayNanoUsd: dayNano,
        spentNanoUsd: spent,
        projectedNanoUsd: projected,
      });
      parts.push(
        `${s.seat} ${formatUsd(spent)} (+${formatUsd(dayNano)}, projected ${formatUsd(projected)})`,
      );
      const calibrated =
        plan.calibratedNanoUsdPerDay ??
        estimateSeat(s.model, 1, plan.clock.kind, plan.cacheTtl, s.effort).central;
      if (dayNano > 2 * calibrated) {
        alert(
          `${s.seat} spent ${formatUsd(dayNano)} on day ${day}, over twice the calibrated ${formatUsd(calibrated)} per day`,
        );
      }
      if (projected > s.capNanoUsd && !alerted.has(`${s.seat}:cap`)) {
        alerted.add(`${s.seat}:cap`);
        alert(
          `${s.seat} is projected at ${formatUsd(projected)} for ${toDays} days, over its cap ${formatUsd(s.capNanoUsd)}`,
        );
      }
    }
    if (llm.length > 0) {
      const match =
        budget === null
          ? ""
          : ` · match ${formatUsd(budget.spentNanoUsd)} of ${formatUsd(budget.budgetNanoUsd)}`;
      say(`D${day + 1} 00:00 spend: ${parts.join(" · ")}${match}\n`);
    }
  };

  const names: Record<string, string> = {};
  for (const s of llm) names[s.seat] = shortName(s.profile.name);
  const watch = watchFold({ names });
  let stopped = false;
  const sink: LogSink = {
    write(line: LogLine) {
      const t = line.k === "header" ? 0 : line.t;
      if (cutAfter !== null && t > cutAfter) {
        throw new ArenaCut(`the arena aborted at t = ${cutAfter}: the log is cut here`);
      }
      if (plan.stopAt !== null && t > plan.stopAt) {
        stopped = true;
        throw new ArenaCut(
          `--stop-after: the run stops at t = ${plan.stopAt}: the log is cut here`,
        );
      }
      lastT = Math.max(lastT, t);
      files.write(line);
      if (plan.watch) for (const w of watch(line)) io.out(`${w}\n`);
      if (line.k === "ckpt" && line.hour % 24 === 0) dayBoundary(line.hour / 24);
    },
    snapshot(snap) {
      if (cutAfter === null) files.snapshot(snap);
    },
    flush() {
      files.flush();
    },
  };

  const options: RunMatchOptions = {
    setup,
    ruleset: plan.ruleset,
    agents,
    sink,
    handoffQueue: ledger,
    invariants: plan.invariants,
    snapshotEvery: plan.snapshotEvery,
    strict: false,
    ...(virtual === null ? { wall: harness.systemWall } : {}),
    clock:
      plan.clock.kind === "lockstep"
        ? { kind: "lockstep", roundTimeoutMs: plan.clock.roundTimeoutMs, time }
        : {
            kind: "realtime",
            speed: plan.clock.speed,
            time,
            timeKind: plan.time,
            latencyMs: plan.clock.botLatencyMs,
            turnTimeoutMs: plan.clock.turnTimeoutMs,
          },
  };
  const t0 = performance.now();
  let result: RunResult | null = null;
  let error: string | null = null;
  try {
    const go = (): Promise<RunResult> => runMatch(options);
    result = await (virtual === null ? go() : virtual.run(go));
  } catch (err) {
    error = errorText(err);
  } finally {
    unsubscribe?.();
  }
  const elapsedMs = Math.round(performance.now() - t0);
  wall.end = iso();
  files.flush();
  files.close();

  const lines = [...readLogLines(paths.log)];
  const summary = summarize(lines, { wallMs: elapsedMs });
  writeFileAtomic(paths.summary, `${JSON.stringify(summary, null, 2)}\n`);
  // The feed file keeps player text whole (the live watch cuts it at 120 characters).
  const feed = watchFold({ names, cut: 100_000 });
  writeFileAtomic(paths.feed, lines.flatMap((l) => feed(l).map((w) => `${w}\n`)).join(""));
  const abortError = stop.aborted;
  if (abortError !== null) {
    status = "aborted";
    reason = abortError.message;
  } else if (stopped && summary.status !== "fatal") {
    status = "stopped";
    reason = `${STOPPED} ${(plan.stopAt ?? 0) / 86_400} (--stop-after; the match lasts ${matchDays} days)`;
  } else if (summary.status === "fatal") {
    status = "fatal";
    reason = summary.fatal === null ? error : `${summary.fatal.kind}: ${summary.fatal.message}`;
  } else if (summary.status === "ended") {
    status = "ended";
    reason = null;
  } else {
    status = "incomplete";
    reason = error;
  }
  let levelE = levelEOf(paths.log);
  if (status === "stopped" && !levelE.ok && levelE.divergence?.startsWith("end at") === true) {
    // The cut log has no end line by design: Level E holds up to the cut.
    levelE = { ...levelE, ok: true, divergence: null };
  }
  let final = report(levelE);
  const te = turnErrors(final);
  if ((status === "ended" || status === "stopped") && te.degraded) {
    const pct = Math.round((te.errors * 100) / te.turns);
    const why = `${te.errors} of ${te.turns} LLM turns (${pct}%) closed by an error (the seats' errors and turn lines say which)`;
    reason = status === "stopped" ? `${reason ?? ""}; ${why}` : why;
    status = "degraded";
    alert(`degraded run: ${why}`);
    final = report(levelE);
  }
  writeReport(final);
  say(formatReport(final));
  say(`run directory: ${o.dir} (${Math.round(elapsedMs / 1000)} s)\n`);
  if (status === "ended" && summary.endedAt !== null) {
    say(`ended at ${fmtTime(summary.endedAt)}; verify with: bun run sim -- verify ${o.dir}\n`);
  }
  let code: ExitCode;
  if (status === "ended" || status === "stopped") code = levelE.ok ? EXIT.ok : EXIT.divergence;
  else if (status === "degraded") code = levelE.ok ? EXIT.fatal : EXIT.divergence;
  else code = EXIT.fatal;
  return { code, status, report: final, paths, error, result };
}

function missing(seat: PlayerId): never {
  throw new Error(`no LLM seat ${seat} in the plan`);
}
