import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { findRuleset } from "@perfidia/engine";
import { sha256Hex } from "@perfidia/engine/core";
import { VirtualTime, type TurnHandle } from "@perfidia/gateway/clock";
import { seatOf, type LastTurn } from "@perfidia/gateway/seat";
import { copyOf } from "@perfidia/gateway/runtime";
import {
  JsonObjectSchema,
  PlayerIdSchema,
  z,
  type JsonObject,
  type LogLine,
  type MatchResult,
  type PlayerId,
  type RoundOutput,
  type SeatAgent,
  type ToolResult,
  type TurnLine,
  type WakeLine,
} from "@perfidia/protocol";
import { harness, writeFileAtomic } from "@perfidia/sim";
import { BudgetLedger } from "../../budget/ledger.ts";
import { MemoryCallLog } from "../../log/calls.ts";
import type { ChatRequest, ChatResult, ModelCall } from "../../model/adapter.ts";
import { seededRandom } from "../../model/clock.ts";
import type { Cost } from "../../model/prices.ts";
import { RateGate } from "../../model/rate.ts";
import { TOOL_NAME } from "../../model/tools.ts";
import { LOCKSTEP_POLICY, LlmSeatAgent } from "../../seat/agent.ts";
import { NoPauseGate } from "../../seat/pause.ts";
import {
  PlaytestError,
  findTarget,
  forkAt,
  ForkSink,
  parseAt,
  playOn,
  readRunLog,
  type Fork,
  type RunLog,
  type Target,
} from "./fork.ts";
import { PlaytestAdapter, cacheTtlOf, readSeats, seatSetup, type SeatSetup } from "./seat.ts";

// A playtest session (`arena playtest`): one LLM seat of a run played turn by turn by an outside
// player, through the real harness, with no model API. The session directory holds the session
// (`session.json`), its steps (`steps.jsonl`: each reply and each `next`, in order) and the
// material rendered from them; nothing else carries state between commands.
//
// Every command re-derives the whole session from the run's log: the fork at the cut (`fork.ts`),
// then the gateway's lockstep driver with the seat's `LlmSeatAgent` on a `PlaytestAdapter`, and a
// bot on every other seat (a bot seat's own, an LLM seat's hand-off bot, or `--brain`). The adapter
// answers the seat's requests with the session's replies in order; at the first request no reply
// answers, the derivation stops there ("await_reply"). A turn line of the seat stops it too, unless
// the next step is a `next` ("turn_ended"). Each reply step records the turn, round and request
// sha256 it answered, and a later derivation must meet the same requests: the session is
// deterministic, and a build that would play it differently says so instead of drifting.

export const SESSION_FORMAT = "perfidia-playtest/1";
export const SESSION_FILE = "session.json";
export const STEPS_FILE = "steps.jsonl";

const Int = z.int().nonnegative();

export const SessionFileSchema = z.strictObject({
  format: z.literal(SESSION_FORMAT),
  /** The run directory (absolute); only ever read. */
  run: z.string().min(1),
  /** sha256 of the run's `match.jsonl` and `seats.json`: a run that changed is refused. */
  runLog: z.string(),
  seats: z.string(),
  seat: PlayerIdSchema,
  /** `--at` as given. */
  at: z.string().min(1),
  target: z.strictObject({
    turn: z.int().positive(),
    t: Int,
    wakeIndex: Int,
    cut: Int,
    mode: z.enum(["second", "mid-second"]),
  }),
  /** The bot of every other seat (`bot:<strategy>@<n>`). */
  brains: z.record(PlayerIdSchema, z.string().min(1)),
});
export type SessionFile = z.infer<typeof SessionFileSchema>;

export const PlaytestCallSchema = z.strictObject({
  name: z.string().regex(TOOL_NAME),
  args: JsonObjectSchema,
});
export type PlaytestCall = z.infer<typeof PlaytestCallSchema>;

const ReplyStepSchema = z.strictObject({
  k: z.literal("reply"),
  text: z.array(z.string()),
  calls: z.array(PlaytestCallSchema),
  /** The request it answered: the seat's turn, its round (0-based) and the request's sha256. */
  at: z.strictObject({ turn: z.int().positive(), round: Int, request: z.string() }),
});
const NextStepSchema = z.strictObject({
  k: z.literal("next"),
  /** The turn whose end it passed. */
  at: z.strictObject({ turn: z.int().positive() }),
});
export const StepSchema = z.discriminatedUnion("k", [ReplyStepSchema, NextStepSchema]);
export type Step = z.infer<typeof StepSchema>;
export type ReplyStep = z.infer<typeof ReplyStepSchema>;

/** A step not yet derived: the next command's, whose `at` the derivation fills. */
export type NewStep =
  | {
      readonly k: "reply";
      readonly text: readonly string[];
      readonly calls: readonly PlaytestCall[];
      readonly at?: undefined;
    }
  | { readonly k: "next"; readonly at?: undefined };

/** One request of the seat, as its builder makes it, and what came of it. */
export interface RoundRecord {
  readonly round: number;
  readonly request: ChatRequest;
  /** The provider request the seat's builder makes of it (`build()`). */
  readonly body: unknown;
  /** `JSON.stringify(body)`: the request's bytes. */
  readonly bodyText: string;
  readonly sha256: string;
  reply: ReplyStep | null;
  /** The calls as the host executed them, and their results (in call order). */
  out: RoundOutput | null;
  results: readonly ToolResult[] | null;
}

export interface TurnRecord {
  readonly turn: number;
  readonly wake: WakeLine;
  readonly rounds: RoundRecord[];
  /** The turn line, and the gateway's record of the turn (what the next briefing's lastTurn says). */
  end: { readonly line: TurnLine; readonly lastTurn: LastTurn | null } | null;
}

export type Halt =
  | { readonly kind: "await_reply"; readonly turn: number; readonly round: number }
  | { readonly kind: "turn_ended"; readonly turn: number }
  | { readonly kind: "match_ended"; readonly result: MatchResult }
  | { readonly kind: "error"; readonly message: string };

export interface Derivation {
  readonly halt: Halt;
  readonly turns: readonly TurnRecord[];
  /** The steps the derivation consumed, with their `at`, in order. */
  readonly steps: readonly Step[];
  /** Steps given that the derivation did not reach (a reply after a turn's end, …). */
  readonly unconsumed: number;
  readonly fork: Fork;
  readonly setup: SeatSetup;
  /** The fork's log lines written after the cut (the history replayed before it excluded). */
  readonly forkLines: readonly string[];
}

/** Thrown into the host from the fork's log sink to stop the driver; never seen outside. */
class Stop extends Error {
  override readonly name = "PlaytestStop";
}

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

const tokensOf = (text: string): number => Math.ceil(new TextEncoder().encode(text).length / 4);

/** The call id of the `i`-th call of a playtest reply: stable, so a session re-derives byte for byte. */
export function playtestCallId(seat: PlayerId, turn: number, round: number, i: number): string {
  return `pt-${seat}-${turn}-${round}-${i}`;
}

/** The model's reply a step stands for: text blocks, then tool calls, in Anthropic's content shape. */
function resultOf(req: ChatRequest, step: ReplyStep, model: string, bodyText: string): ChatResult {
  const m = req.meta;
  const text = step.text.filter((t) => t !== "");
  const calls: ModelCall[] = step.calls.map((c, i) => ({
    callId: playtestCallId(m.seat, m.turn, m.round, i),
    name: c.name,
    args: c.args,
  }));
  const native = [
    ...text.map((t) => ({ type: "text", text: t })),
    ...calls.map((c) => ({ type: "tool_use", id: c.callId, name: c.name, input: c.args })),
  ];
  const stop = calls.length > 0 ? "tool_use" : "end_turn";
  return {
    reply: { native, text, calls, reasoning: [] },
    stop,
    rawStop: stop,
    refusal: null,
    servedBy: model,
    fallback: false,
    // An estimate (4 bytes a token) keeps the seat's prompt cap working; nothing is billed.
    usage: [
      {
        model,
        kind: "message",
        tokens: {
          input: tokensOf(bodyText),
          cacheWrite5m: 0,
          cacheWrite1h: 0,
          cacheRead: 0,
          output: tokensOf(JSON.stringify(native)),
        },
        estimated: true,
      },
    ],
    requestId: null,
    latencyMs: 0,
    ttftMs: null,
    raw: { content: native, stop_reason: stop },
  };
}

/** What the derivation watches: the seat's requests, wakes, rounds and turn lines. */
class Runtime {
  readonly turns: TurnRecord[] = [];
  readonly consumed: Step[] = [];
  private next = 0;
  private halted: Halt | null = null;
  private readonly done = Promise.withResolvers<Halt>();
  private firstWake = true;
  fork: Fork | null = null;
  private readonly steps: readonly (Step | NewStep)[];
  private readonly seat: PlayerId;
  private readonly expectedWake: string;
  private readonly setup: SeatSetup;

  constructor(
    steps: readonly (Step | NewStep)[],
    seat: PlayerId,
    expectedWake: string,
    setup: SeatSetup,
  ) {
    this.steps = steps;
    this.seat = seat;
    this.expectedWake = expectedWake;
    this.setup = setup;
  }

  get result(): Promise<Halt> {
    return this.done.promise;
  }

  get unconsumed(): number {
    return this.steps.length - this.next;
  }

  stop(h: Halt): void {
    if (this.halted !== null) return;
    this.halted = h;
    this.done.resolve(h);
  }

  /** The adapter's `chat`: the next reply step, or nothing (the derivation stops here). */
  answer = (req: ChatRequest): Promise<ChatResult> => {
    if (this.halted !== null) return never();
    const m = req.meta;
    const turn = this.turns.find((t) => t.turn === m.turn);
    if (turn === undefined || m.kind !== "round") {
      this.stop({
        kind: "error",
        message: `a ${m.kind} request for turn ${m.turn} the playtest did not see open`,
      });
      return never();
    }
    const body = this.setup.builder.build(req);
    const bodyText = JSON.stringify(body);
    const sha256 = sha256Hex(bodyText);
    const rec: RoundRecord = {
      round: m.round,
      request: { ...req, entries: [...req.entries] },
      body,
      bodyText,
      sha256,
      reply: null,
      out: null,
      results: null,
    };
    turn.rounds.push(rec);
    const step = this.steps[this.next];
    if (step?.k !== "reply") {
      this.stop({ kind: "await_reply", turn: m.turn, round: m.round });
      return never();
    }
    const at = step.at;
    if (at !== undefined) {
      if (at.turn !== m.turn || at.round !== m.round || at.request !== sha256) {
        this.stop({
          kind: "error",
          message: `step ${this.next + 1} answered turn ${at.turn}, round trip ${at.round + 1} (request ${at.request.slice(0, 12)}…); this build asks turn ${m.turn}, round trip ${m.round + 1} (request ${sha256.slice(0, 12)}…): the session no longer replays (the code or the run changed)`,
        });
        return never();
      }
    }
    this.next += 1;
    const done: ReplyStep = {
      k: "reply",
      text: [...step.text],
      calls: step.calls.map((c) => ({ name: c.name, args: c.args })),
      at: { turn: m.turn, round: m.round, request: sha256 },
    };
    this.consumed.push(done);
    rec.reply = done;
    return Promise.resolve(resultOf(req, done, this.setup.spec.model, bodyText));
  };

  /** Wraps the seat's turn handles: each round's executed calls and results are recorded. */
  openTurn = (seat: PlayerId, handle: TurnHandle): TurnHandle => {
    if (seat !== this.seat) return handle;
    const record = this.turns.at(-1);
    return {
      seat: handle.seat,
      get done() {
        return handle.done;
      },
      input: () => handle.input(),
      execute: (out) => {
        handle.execute(out);
        const after = handle.input();
        const rec = record?.rounds.find((r) => r.round === after.round - 1);
        if (rec !== undefined) {
          rec.out = copyOf(out);
          rec.results = after.results;
        }
      },
      close: (failure) => handle.close(failure),
    };
  };

  /** The fork's log lines: the seat's wakes open a turn record, its turn lines end one. */
  onLine = (line: LogLine, text: string): void => {
    if (this.halted !== null) return;
    if (line.k === "wake" && line.seat === this.seat) {
      if (this.firstWake) {
        this.firstWake = false;
        if (text !== this.expectedWake) {
          this.stop({
            kind: "error",
            message: `the fork did not reopen ${this.seat}'s turn as the run did: expected ${this.expectedWake}, got ${text}`,
          });
          throw new Stop();
        }
      }
      this.turns.push({ turn: line.turn, wake: line, rounds: [], end: null });
      return;
    }
    if (line.k !== "turn" || line.seat !== this.seat) return;
    const rec = this.turns.find((t) => t.turn === line.turn);
    const gw = this.fork?.host.gw;
    const lastTurn = gw === undefined ? null : copyOf(seatOf(gw, this.seat).lastTurn);
    if (rec !== undefined) rec.end = { line, lastTurn };
    const step = this.steps[this.next];
    if (step?.k === "next") {
      if (step.at !== undefined && step.at.turn !== line.turn) {
        this.stop({
          kind: "error",
          message: `step ${this.next + 1} passed the end of turn ${step.at.turn}; this build ends turn ${line.turn} there: the session no longer replays`,
        });
        throw new Stop();
      }
      this.next += 1;
      this.consumed.push({ k: "next", at: { turn: line.turn } });
      return;
    }
    this.stop({ kind: "turn_ended", turn: line.turn });
    throw new Stop();
  };
}

/** A playtest bills nothing: every attempt of the seat is priced at zero. */
const zero = (): Cost => ({
  nanoUsd: 0,
  feeNanoUsd: 0,
  unpriced: [],
  longPrompt: false,
  cards: [],
});

/** The agents of a derivation: the bots of `brains`, and the seat's LLM agent. */
function agentsOf(
  run: RunLog,
  session: SessionFile,
  setup: SeatSetup,
  rt: Runtime,
): Map<PlayerId, SeatAgent> {
  const seed = run.header.setup.seed;
  const agents = new Map<PlayerId, SeatAgent>();
  for (const s of run.header.setup.seats) {
    if (s.id === session.seat) continue;
    const label = session.brains[s.id];
    if (label === undefined) throw new PlaytestError(`the session names no bot for ${s.id}`);
    agents.set(s.id, harness.agentFromLabel(label, s.id, seed));
  }
  const time = new VirtualTime({ yieldMacrotask: () => Promise.resolve() });
  const clock = { time, random: seededRandom(seed) };
  const ledger = new BudgetLedger({
    caps: new Map([[session.seat, 1_000_000_000_000_000]]),
    wakeCapNanoUsd: null,
    handoffTo: () => {
      throw new PlaytestError("a playtest seat is never handed off");
    },
    pricers: new Map([[session.seat, zero]]),
  });
  agents.set(
    session.seat,
    new LlmSeatAgent({
      seat: session.seat,
      adapter: new PlaytestAdapter(setup.builder, rt.answer),
      prompt: setup.prompt,
      tools: setup.tools,
      profile: setup.profile,
      ledger,
      log: new MemoryCallLog({ transcripts: false }),
      clock,
      gate: new NoPauseGate(),
      rate: new RateGate({ clock, maxInflight: 1 }),
      policy: { ...LOCKSTEP_POLICY, promptCapTokens: setup.promptCapTokens },
      promptVariant: setup.variant,
      reminders: setup.reminders,
    }),
  );
  return agents;
}

/** The run of a session: read, and checked to be the one the session was started on. */
export function sessionRun(session: SessionFile): {
  readonly run: RunLog;
  readonly seats: ReturnType<typeof readSeats>;
} {
  const run = readRunLog(session.run);
  const seats = readSeats(session.run);
  if (run.sha256 !== session.runLog || seats.sha256 !== session.seats) {
    throw new PlaytestError(
      `${session.run} changed since the session started (match.jsonl or seats.json): start a new session`,
    );
  }
  return { run, seats };
}

/** Derives a session with `steps` (its own, then at most one new step). */
export async function derive(
  session: SessionFile,
  steps: readonly (Step | NewStep)[],
  loaded: { readonly run: RunLog; readonly seats: ReturnType<typeof readSeats> } = sessionRun(
    session,
  ),
): Promise<Derivation> {
  const { run, seats } = loaded;
  const target = findTarget(run, session.seat, parseAt(session.at));
  const t = session.target;
  if (
    target.turn !== t.turn ||
    target.t !== t.t ||
    target.wakeIndex !== t.wakeIndex ||
    target.cut !== t.cut ||
    target.mode !== t.mode
  ) {
    throw new PlaytestError(
      "the session's target no longer resolves to the same turn: start a new session",
    );
  }
  const ruleset = findRuleset(run.header.setup.ruleset);
  if (ruleset === undefined) {
    throw new PlaytestError(`the run's ruleset ${run.header.setup.ruleset} is not in this build`);
  }
  const setup = seatSetup(run, seats.file, ruleset, session.seat, cacheTtlOf(session.run));
  const rt = new Runtime(steps, session.seat, run.texts[target.wakeIndex] ?? "", setup);
  const agents = agentsOf(run, session, setup, rt);
  const sink = new ForkSink();
  const fork = forkAt(run, target, agents, sink);
  rt.fork = fork;
  const from = sink.lines.length;
  sink.onLine = rt.onLine;
  playOn(fork, agents, rt.openTurn).then(
    (result) => rt.stop({ kind: "match_ended", result }),
    (e: unknown) => {
      const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      rt.stop({ kind: "error", message });
    },
  );
  const halt = await rt.result;
  return {
    halt,
    turns: rt.turns,
    steps: rt.consumed,
    unconsumed: rt.unconsumed,
    fork,
    setup,
    forkLines: sink.lines.slice(from),
  };
}

/** The bot of every seat but `seat`: a bot seat's own, an LLM seat's hand-off bot, or `--brain`. */
export function brainsOf(
  seats: ReturnType<typeof readSeats>["file"],
  seat: PlayerId,
  overrides: Readonly<Record<string, string>>,
): Record<PlayerId, string> {
  const out: Record<PlayerId, string> = {};
  for (const s of seats.seats) {
    if (s.seat === seat) continue;
    const given = overrides[s.seat];
    out[s.seat] =
      given === undefined
        ? s.kind === "bot"
          ? s.label
          : s.handoffBot
        : given.startsWith("bot:")
          ? given
          : `bot:${given}`;
  }
  for (const k of Object.keys(overrides)) {
    if (k === seat) throw new PlaytestError(`--brain ${k}: that is the playtested seat`);
    if (!Object.hasOwn(out, k)) throw new PlaytestError(`--brain ${k}: not a seat of this run`);
  }
  return out;
}

/** A new session's file, for `seat` at `at` of the run in `runDir`. */
export function newSession(
  runDir: string,
  seat: PlayerId,
  at: string,
  brains: Readonly<Record<string, string>>,
): SessionFile {
  const dir = resolve(runDir);
  const run = readRunLog(dir);
  const seats = readSeats(dir);
  const target: Target = findTarget(run, seat, parseAt(at));
  const all = brainsOf(seats.file, seat, brains);
  for (const s of run.header.setup.seats) {
    // A bot that does not exist fails here, not in the middle of a derivation.
    const label = all[s.id];
    if (label === undefined) continue;
    try {
      harness.agentFromLabel(label, s.id, run.header.setup.seed);
    } catch (e) {
      throw new PlaytestError(`${s.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return SessionFileSchema.parse({
    format: SESSION_FORMAT,
    run: dir,
    runLog: run.sha256,
    seats: seats.sha256,
    seat,
    at,
    target: {
      turn: target.turn,
      t: target.t,
      wakeIndex: target.wakeIndex,
      cut: target.cut,
      mode: target.mode,
    },
    brains: all,
  });
}

export function readSession(dir: string): {
  readonly session: SessionFile;
  readonly steps: Step[];
} {
  const path = join(dir, SESSION_FILE);
  if (!existsSync(path))
    throw new PlaytestError(`${dir}: no ${SESSION_FILE} (not a playtest session)`);
  const parsed = SessionFileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new PlaytestError(`${path} is not a ${SESSION_FORMAT} session`);
  const stepsPath = join(dir, STEPS_FILE);
  const steps = existsSync(stepsPath)
    ? readFileSync(stepsPath, "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l, i) => {
          const s = StepSchema.safeParse(JSON.parse(l));
          if (!s.success) throw new PlaytestError(`${stepsPath}: line ${i + 1} is not a step`);
          return s.data;
        })
    : [];
  return { session: parsed.data, steps };
}

export function writeSession(dir: string, session: SessionFile, steps: readonly Step[]): void {
  writeFileAtomic(join(dir, SESSION_FILE), `${JSON.stringify(session, null, 2)}\n`);
  writeFileAtomic(join(dir, STEPS_FILE), steps.map((s) => `${JSON.stringify(s)}\n`).join(""));
}

/** A new session directory must not exist, or be empty. */
export function assertFreeSessionDir(dir: string): void {
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new PlaytestError(`${dir} is not empty: a playtest session needs a new directory`);
  }
}

/** A tool call as a playtester writes it: `{name, args}`, `{tool, args}` or `{name, input}`. */
export function callOf(value: unknown, where: string): PlaytestCall {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PlaytestError(`${where}: a call is an object {"name": "...", "args": {...}}`);
  }
  const name: unknown = Reflect.get(value, "name") ?? Reflect.get(value, "tool");
  const rawArgs: unknown = Reflect.get(value, "args") ?? Reflect.get(value, "input") ?? {};
  if (typeof name !== "string" || !TOOL_NAME.test(name)) {
    throw new PlaytestError(`${where}: "name" must be a tool name, got ${JSON.stringify(name)}`);
  }
  const args = JsonObjectSchema.safeParse(rawArgs);
  if (!args.success) {
    throw new PlaytestError(
      `${where}: the arguments of ${name} must be a JSON object (a model's tool input always is)`,
    );
  }
  return { name, args: args.data };
}

/** The calls file: an array of calls, or `{"text": "..." | [...], "calls": [...]}`. */
export function replyFileOf(
  value: unknown,
  file: string,
): {
  readonly text: readonly string[];
  readonly calls: readonly PlaytestCall[];
} {
  if (Array.isArray(value)) {
    return { text: [], calls: value.map((c, i) => callOf(c, `${file}: call ${i + 1}`)) };
  }
  if (value !== null && typeof value === "object") {
    const rawText: unknown = Reflect.get(value, "text");
    const rawCalls: unknown = Reflect.get(value, "calls") ?? [];
    const text =
      rawText === undefined
        ? []
        : typeof rawText === "string"
          ? [rawText]
          : Array.isArray(rawText) && rawText.every((t) => typeof t === "string")
            ? rawText
            : null;
    if (text === null) throw new PlaytestError(`${file}: "text" must be a string or strings`);
    if (!Array.isArray(rawCalls)) throw new PlaytestError(`${file}: "calls" must be an array`);
    return { text, calls: rawCalls.map((c, i) => callOf(c, `${file}: call ${i + 1}`)) };
  }
  throw new PlaytestError(`${file}: give an array of calls, or {"text": "...", "calls": [...]}`);
}

/** The arguments object of a call, as JSON (for reading). */
export const argsText = (args: JsonObject): string => JSON.stringify(args);
