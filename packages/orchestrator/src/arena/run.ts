import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMatch, verifyLog } from "@perfidia/engine";
import { canonicalJson, fmtTime, sha256Hex } from "@perfidia/engine/core";
import { rulesInfo } from "@perfidia/gateway/present";
import {
  runMatch,
  toolDefinitions,
  type LogSink,
  type RunMatchOptions,
  type RunResult,
} from "@perfidia/gateway/runtime";
import type { LogLine, PlayerId, SeatAgent, TimeSource } from "@perfidia/protocol";
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
import { BudgetLedger } from "../budget/ledger.ts";
import { FileCallLog, writePrompts, type CallLog } from "../log/calls.ts";
import {
  SeatsFileSchema,
  type ArenaReport,
  type ArenaStatus,
  type LlmLogLine,
  type SeatsFile,
} from "../log/schema.ts";
import { watchLines } from "../log/watch.ts";
import type { ModelAdapter, ModelSpec } from "../model/adapter.ts";
import { AnthropicAdapter, AnthropicClient, type HttpFetch } from "../model/anthropic.ts";
import { seededRandom, type HarnessClock } from "../model/clock.ts";
import { FakeAdapter } from "../model/fake.ts";
import { formatUsd } from "../model/prices.ts";
import { RateGates } from "../model/rate.ts";
import { anthropicTools } from "../model/tools.ts";
import { LlmSeatAgent } from "../seat/agent.ts";
import { ArenaPauseGate, type ArenaAborted, type PauseReason } from "../seat/pause.ts";
import { PROMPT_VERSION, operatorTemplates, seatPrompt, sharedPrompt } from "../seat/prompt.ts";
import { botBrain } from "./brain.ts";
import { estimateSeat, projectSpend } from "./cost.ts";
import { groupsOf, preflight, type PreflightGroup } from "./preflight.ts";
import {
  DEFAULT_ARENA_DAYS,
  llmSeatsOf,
  matchEndOf,
  type ArenaPlan,
  type LlmSeatPlan,
} from "./plan.ts";
import { HARNESS_VERSION, buildReport, formatReport, type DayRow, type LevelE } from "./report.ts";

// `arena run` (phase-2 design §1.4, §6): builds the agents (LLM seats on the Anthropic adapter, or
// on the bot-backed fake with `--fake`; bots through the sim harness), runs the preflight before
// anything is written, then runs the match through the gateway's `runMatch` into a run directory:
//
//   match.jsonl, snapshots/, summary.json   as `sim run` writes them (Level E checked at the end)
//   llm_calls.jsonl, transcripts/, prompts/ the LLM logs (§5.1, §4.5)
//   seats.json                              who played what, with the prompt hashes
//   feed.txt                                the `--watch` text of the whole match (a fold of match.jsonl)
//   arena.json                              the report (§6), rewritten at each status change
//
// Systematic API failures close the arena pause gate (§2.6): in lockstep the round waits and a
// probe (the preflight) reopens it, and after `--pause-max` the arena aborts; in real time it
// aborts at once. An abort lets the game second it happened in finish (every LLM round of it is
// refused, so each open turn closes with `why: "error"`), then cuts the log at the first line of
// a later second: the host's write fails and the driver stops. `match.jsonl` ends without an end
// line, the summary says `incomplete`, and the exit code is 2. In lockstep no turn is left open;
// in real time a bot still thinking at the cut keeps its turn open (the gateway rebuild lists it).

export const ARENA_FILE = "arena.json";
export const SEATS_FILE = "seats.json";
export const FEED_FILE = "feed.txt";
export const CALLS_FILE = "llm_calls.jsonl";

export interface ArenaPaths {
  readonly dir: string;
  readonly log: string;
  readonly calls: string;
  readonly arena: string;
  readonly seats: string;
  readonly feed: string;
  readonly summary: string;
}

export function arenaPaths(dir: string): ArenaPaths {
  return {
    dir,
    log: join(dir, "match.jsonl"),
    calls: join(dir, CALLS_FILE),
    arena: join(dir, ARENA_FILE),
    seats: join(dir, SEATS_FILE),
    feed: join(dir, FEED_FILE),
    summary: join(dir, "summary.json"),
  };
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

const pauseText = (r: PauseReason): string =>
  `${r.kind}: ${r.message}${r.seat === null ? "" : ` (${r.seat}${r.model === null ? "" : `, ${r.model}`})`}`;

/** Runs a planned arena match into `o.dir` (which must not hold a run). */
export async function runArena(plan: ArenaPlan, o: RunArenaOptions): Promise<ArenaOutcome> {
  const io = o.io;
  const say = (text: string): void => {
    if (o.quiet !== true) io.out(text);
  };
  const setup = plan.setup;
  const seed = setup.seed;
  const llm = llmSeatsOf(plan);
  const info = rulesInfo(createMatch(setup, plan.ruleset));
  const tools = anthropicTools(toolDefinitions(plan.ruleset));
  const shared = sharedPrompt(info, setup.seats.length);

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
  const pre = await preflight(groups);
  for (const r of pre.reports) {
    say(
      `preflight ${r.model}: ok${r.allowedFallbackModels.length === 0 ? "" : `, fallbacks ${r.allowedFallbackModels.join(", ")}`}\n`,
    );
  }

  // The run directory.
  const files = new RunDirSink(o.dir);
  const paths = arenaPaths(o.dir);
  const calls = new FileCallLog(o.dir, { transcripts: plan.transcripts });
  const operator = operatorTemplates();
  writePrompts(o.dir, {
    shared,
    seats: Object.fromEntries(prompts),
    operator,
    tools,
  });
  const agentLabels = new Map<PlayerId, string>();

  const llmLines: LlmLogLine[] = [];
  const log: CallLog = {
    write(line) {
      calls.write(line);
      llmLines.push(line);
      if (line.k === "llm_call") {
        if (line.fallback) {
          io.err(
            `${line.seat} turn ${line.turn}: served by the fallback model ${line.servedBy ?? "?"} (requested ${line.model})\n`,
          );
        }
        if (line.stop === "refusal") {
          io.err(
            `${line.seat} turn ${line.turn}: refusal (${line.refusal?.category ?? "uncategorised"}) on ${line.servedBy ?? line.model}\n`,
          );
        }
      } else if (line.k === "handoff") {
        io.err(
          `${line.seat}: over its cap (${formatUsd(line.spentNanoUsd)} of ${formatUsd(line.capNanoUsd)}): handed to ${line.label} at its next turn\n`,
        );
      } else if (line.k === "wake_cap") {
        io.err(
          `${line.seat} turn ${line.turn}: wake cap reached (${formatUsd(line.wakeSpentNanoUsd)}): the turn ends\n`,
        );
      }
    },
    transcript(record) {
      calls.transcript(record);
    },
  };

  // Status, pauses and alerts.
  const alerts: string[] = [];
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
      preflightNanoUsd: pre.nanoUsd,
    });
  const writeReport = (r: ArenaReport): void =>
    writeFileAtomic(paths.arena, `${JSON.stringify(r, null, 2)}\n`);
  const alert = (text: string): void => {
    alerts.push(text);
    io.err(`ALERT: ${text}\n`);
  };

  /** After an abort: the last game second the log may still hold. */
  let cutAfter: number | null = null;
  let lastT = 0;
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
  const gate = new ArenaPauseGate({
    clock,
    mode: plan.clock.kind === "lockstep" ? "wait" : "abort",
    probe: async () => {
      try {
        await preflight(groups);
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
      alert(
        `the arena is paused: ${pauseText(r)}. Game time stands still; the preflight is re-run every ${Math.round((o.probeEveryMs ?? 120_000) / 1000)} s and the arena aborts after ${Math.round(plan.pauseMaxMs / 60_000)} min of pause`,
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
      pauseLine(e.reason, "aborted", pauseStart === null ? 0 : time.nowMs() - pauseStart.ms);
      alert(e.message);
    },
  });

  const rates = new RateGates({ clock, maxInflight: plan.maxInflight });
  const seatPlanOf = (seat: PlayerId): LlmSeatPlan =>
    llm.find((s) => s.seat === seat) ?? missing(seat);
  const ledger = new BudgetLedger({
    caps: new Map(llm.map((s) => [s.seat, s.capNanoUsd])),
    wakeCapNanoUsd: plan.wakeCapNanoUsd,
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
  });

  const agents = new Map<PlayerId, SeatAgent>();
  for (const s of plan.seats) {
    if (s.kind === "bot") {
      agents.set(s.seat, harness.agentFromLabel(s.label, s.seat, seed, think));
      agentLabels.set(s.seat, s.label);
      continue;
    }
    const adapter = adapters.get(s.seat) ?? missing(s.seat);
    const agent = new LlmSeatAgent({
      seat: s.seat,
      adapter,
      prompt: { shared, seat: prompts.get(s.seat) ?? "" },
      tools,
      profile: s.profile,
      ledger,
      log,
      clock,
      gate,
      rate: rates.gate(adapter.spec.provider, adapter.spec.model),
      policy: plan.policy,
    });
    agents.set(s.seat, agent);
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
          },
    ),
  });
  writeFileSync(paths.seats, `${JSON.stringify(seatsFile, null, 2)}\n`);

  // The plan, then the a-priori estimate (§5.4).
  const matchDays = Math.round(matchEndOf(plan) / 86_400);
  say(
    `arena: ${plan.setup.ruleset}, seed ${seed}, ${setup.seats.length} players, ${matchDays} day(s), ${plan.clock.kind}${plan.fake ? ", fake models ($0)" : ""}\n`,
  );
  for (const s of plan.seats) {
    if (s.kind === "bot") say(`  ${s.seat}  ${s.label}\n`);
    else {
      const est = estimateSeat(s.model, matchDays, plan.clock.kind, plan.cacheTtl);
      say(
        `  ${s.seat}  ${agentLabels.get(s.seat) ?? ""}  cap ${formatUsd(s.capNanoUsd)}  estimate ${formatUsd(est.central)} (${formatUsd(est.low)}–${formatUsd(est.high)})${plan.fake ? ` [plays ${s.brain}]` : ""}\n`,
      );
    }
  }
  writeReport(report(null));

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
        estimateSeat(s.model, 1, plan.clock.kind, plan.cacheTtl).central;
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
    if (llm.length > 0) say(`D${day + 1} 00:00 spend: ${parts.join(" · ")}\n`);
  };

  const names: Record<string, string> = {};
  for (const s of llm) names[s.seat] = shortName(s.profile.name);
  const sink: LogSink = {
    write(line: LogLine) {
      const t = line.k === "header" ? 0 : line.t;
      if (cutAfter !== null && t > cutAfter) {
        throw new ArenaCut(`the arena aborted at t = ${cutAfter}: the log is cut here`);
      }
      lastT = Math.max(lastT, t);
      files.write(line);
      if (plan.watch) for (const w of watchLines(line, { names })) io.out(`${w}\n`);
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
  } catch (e) {
    error = errorText(e);
  }
  const elapsedMs = Math.round(performance.now() - t0);
  files.flush();

  const lines = [...readLogLines(paths.log)];
  const summary = summarize(lines, { wallMs: elapsedMs });
  writeFileAtomic(paths.summary, `${JSON.stringify(summary, null, 2)}\n`);
  writeFileAtomic(
    paths.feed,
    lines.flatMap((l) => watchLines(l, { names }).map((w) => `${w}\n`)).join(""),
  );
  const abortError = stop.aborted;
  if (abortError !== null) {
    status = "aborted";
    reason = abortError.message;
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
  const levelE = levelEOf(paths.log);
  const final = report(levelE);
  writeReport(final);
  say(formatReport(final));
  say(`run directory: ${o.dir} (${Math.round(elapsedMs / 1000)} s)\n`);
  if (status === "ended" && summary.endedAt !== null) {
    say(`ended at ${fmtTime(summary.endedAt)}; verify with: bun run sim -- verify ${o.dir}\n`);
  }
  let code: ExitCode;
  if (status === "ended") code = levelE.ok ? EXIT.ok : EXIT.divergence;
  else code = EXIT.fatal;
  return { code, status, report: final, paths, error, result };
}

function missing(seat: PlayerId): never {
  throw new Error(`no LLM seat ${seat} in the plan`);
}
