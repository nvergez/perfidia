import { canonicalJson, sha256Hex } from "@perfidia/engine/core";
import type { GameTime, PlayerId, RoundInput, RoundOutput, SeatAgent } from "@perfidia/protocol";
import type { BudgetLedger, Charge } from "../budget/ledger.ts";
import { replyLine, type CallLog } from "../log/calls.ts";
import type { LlmCallLine } from "../log/schema.ts";
import {
  ModelError,
  isOperatorKind,
  retryOutputTokens,
  promptTokens,
  servedTokens,
  type CallMeta,
  type ChatRequest,
  type ChatResult,
  type Entry,
  type ModelAdapter,
  type ModelTool,
  type StablePrompt,
  type UsageEntry,
  type UserPart,
} from "../model/adapter.ts";
import { AbortedError, sleepMs, timeoutSignal, type HarnessClock } from "../model/clock.ts";
import type { RateGate } from "../model/rate.ts";
import { ArenaAborted, type PauseGate } from "./pause.ts";
import { profileRef, type Profile } from "./personalities.ts";
import {
  PROMPT_VERSION,
  THOUGHT_ASK,
  THOUGHT_QUEUED,
  roundReminder,
  turnHeader,
} from "./prompt.ts";
import { DEFAULT_BACKOFF, RetryBudget, backoffMs, type BackoffPolicy } from "./retry.ts";
import { thoughtOf } from "./thought.ts";

// The LLM seat (phase-2 design §3): a `SeatAgent` whose rounds are model calls. The gateway drives
// the rounds; the only state across calls is the conversation of the current turn, and round 0 of
// a new turn discards it (one wake, one fresh session: all memory lives in the game).
//
// - Round 0: a user entry with the briefing JSON, then an operator entry (the turn header).
//   Round r ≥ 1: a user entry with one tool result per previous call (all of them in one message,
//   in call order, `is_error` for rejected calls), then an operator entry (the round reminder).
//   Nothing is ever removed: refused and truncated replies are not appended, so every request's
//   prefix is byte-identical to the previous one and is read from the cache.
// - Every attempt awaits the arena pause gate and the model's rate gate, is charged to the ledger
//   (failed and estimated attempts too) and logged; retryable errors back off with full jitter
//   within the retry budget; operator-recoverable errors close the pause gate and wait.
// - The public thought comes only from a terminal reply: no tool call, a reply carrying
//   `end_turn`, or the last round trip.
// - Over the seat's cap, or halted (the match budget's kill switch, the operator): `{calls: []}`
//   and a hand-off request. `ledger.over` is checked right before every attempt and thought call,
//   after the pause and rate gates (phase 4): no attempt starts once the kill switch has fired.
//   The per-wake soft cap is checked before every attempt: the first attempt that finds it reached
//   is the wake's last (a `wake_cap` line; when it starts a round, that round's reminder tells the
//   model this reply is its last, so it can end with `end_turn` and keep a self-wake); any later
//   attempt of the wake is not made (`{calls: []}`).
// - The prompt cap (phase 4, `policy.promptCapTokens`): before each attempt and thought call, the
//   prompt is estimated from above (`promptEstimate`: the last measured prompt of the turn, its
//   reply's output and the bytes appended since, or the stable prefix and the bytes of the turn);
//   over the cap, nothing is sent, a `prompt_cap` line is written, and the turn closes (not
//   systemic). Every attempt's prompt is therefore bounded, and so is what it can cost.
// - A turn-closing error is `systemic` (it counts toward the breaker) unless it is a refusal, a
//   truncation or a deadline abort: those are about one request, not about the API or the harness.
// - Every reply that arrived and that the conversation keeps (`end_turn` or `tool_use`) gets a
//   `replies.jsonl` line right after its `llm_call` line (phase 3, for the spectators): its
//   reasoning summaries, text and calls. A late completion of a round the host has moved on from
//   is logged too: the reply did arrive.

/** A turn-closing failure; its message is one deterministic line (no wall durations). */
export class AgentError extends Error {
  override readonly name = "AgentError";
  /** Counts toward the breaker's rule (b): not a refusal, a truncation or a deadline abort. */
  readonly systemic: boolean;

  constructor(message: string, systemic = true) {
    super(message);
    this.systemic = systemic;
  }
}

export interface SeatPolicy {
  /** Retry waits per round, paused time excluded: 60 min in lockstep, the deadline in real time. */
  readonly retryBudgetMs: number;
  /** The prompt cap in tokens (phase 4); absent: none. */
  readonly promptCapTokens?: number;
  /** Backstop of one attempt; it aborts the request, and the attempt counts as a timeout. */
  readonly attemptTimeoutMs: number;
  /** The agent's own round deadline (the driver's timeout minus a margin); `null`: none. */
  readonly roundDeadlineMs: number | null;
  /** The out-of-band thought call when a terminal reply has no text (§3.5). */
  readonly thoughtCall: boolean;
  readonly backoff?: BackoffPolicy;
  /** A cache read below this share of the previous prompt of the turn is a `cacheMiss`; default 0.8. */
  readonly cacheMissShare?: number;
}

export const LOCKSTEP_POLICY: SeatPolicy = Object.freeze({
  retryBudgetMs: 60 * 60_000,
  attemptTimeoutMs: 10 * 60_000,
  roundDeadlineMs: null,
  thoughtCall: false,
});

/** How long a 429 or 529 without `retry-after` holds the model's other requests. */
const DEFAULT_HOLD_MS = 5_000;

export interface LlmSeatOptions {
  readonly seat: PlayerId;
  readonly adapter: ModelAdapter;
  readonly prompt: StablePrompt;
  readonly tools: readonly ModelTool[];
  readonly profile: Profile;
  readonly ledger: BudgetLedger;
  readonly log: CallLog;
  readonly clock: HarnessClock;
  readonly gate: PauseGate;
  readonly rate: RateGate;
  readonly policy: SeatPolicy;
  /**
   * An upper bound of the stable prefix in tokens (tools and both system blocks): the measured
   * prompt of the preflight's shape check when there is one. Default: one token per UTF-8 byte of
   * the prefix, an upper bound for byte-level tokenizers.
   */
  readonly prefixTokens?: number;
}

/** What one part of a conversation entry may add to a prompt besides its bytes (role, ids, wrappers). */
export const ENTRY_OVERHEAD_TOKENS = 32;

const utf8 = new TextEncoder();
const bytesOf = (text: string): number => utf8.encode(text).length;

/**
 * An upper bound of the prompt tokens of `entry`: one token per UTF-8 byte of its text (no
 * byte-level tokenizer makes more) plus `ENTRY_OVERHEAD_TOKENS` per part. An assistant entry counts
 * its native content's JSON bytes; `promptEstimate` counts a reply by its measured output instead.
 */
export function entryTokensUpper(entry: Entry): number {
  if (entry.role === "operator") return bytesOf(entry.text) + ENTRY_OVERHEAD_TOKENS;
  if (entry.role === "assistant") {
    return bytesOf(JSON.stringify(entry.reply.native) ?? "") + ENTRY_OVERHEAD_TOKENS;
  }
  let n = 0;
  for (const p of entry.parts) {
    n +=
      (p.kind === "text" ? bytesOf(p.text) : bytesOf(p.content) + bytesOf(p.callId)) +
      ENTRY_OVERHEAD_TOKENS;
  }
  return n;
}

/** The last answered request of a turn: its prompt and output tokens, and how many entries it had. */
export interface KnownPrompt {
  readonly prompt: number;
  readonly output: number;
  readonly entries: number;
}

/**
 * An upper bound of the prompt of a request with `entries` (phase-4 design §5.2): the same entries
 * as the last answered request of the turn (a retry) cost its measured prompt; more entries cost
 * that prompt, its reply's measured output and the appended non-reply entries
 * (`entryTokensUpper`); without a measured request in the turn (round 0), the stable prefix and
 * every entry. Each round starts from a measured prompt, so the overestimate never accumulates.
 */
export function promptEstimate(
  entries: readonly Entry[],
  known: KnownPrompt | null,
  prefixTokens: number,
): number {
  if (known !== null && entries.length >= known.entries) {
    if (entries.length === known.entries) return known.prompt;
    let n = known.prompt + known.output;
    for (const e of entries.slice(known.entries)) {
      if (e.role !== "assistant") n += entryTokensUpper(e);
    }
    return n;
  }
  let n = prefixTokens;
  for (const e of entries) n += entryTokensUpper(e);
  return n;
}

interface TurnState {
  readonly turn: number;
  readonly entries: Entry[];
  /** Call ids of the last reply, matched with the next round's results. */
  pending: string[];
  /** Total prompt tokens of the previous answered request of the turn (the cache-miss check). */
  lastPrompt: number;
  /** Entries already written to the transcript. */
  logged: number;
  /** The per-wake soft cap: `used` once an attempt was made with the cap reached (the wake's last). */
  capGrant: "none" | "used";
  /** The last answered round request of the turn (the prompt cap's estimate). */
  known: KnownPrompt | null;
}

interface Where {
  readonly input: RoundInput;
  readonly t: GameTime;
  readonly kind: "round" | "thought_call";
}

const userOf = (parts: readonly UserPart[]): Entry => ({ role: "user", parts });
const operatorOf = (text: string): Entry => ({ role: "operator", text });

function asModelError(e: unknown): ModelError {
  if (e instanceof ModelError) return e;
  const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return new ModelError("unknown", message.replaceAll(/\s+/g, " ").slice(0, 300));
}

/** The game time a request is built on: the briefing's in round 0, else the latest result's. */
function requestTime(input: RoundInput): GameTime {
  let t = input.briefing.t;
  for (const r of input.results) if (r.t > t) t = r.t;
  return t;
}

export class LlmSeatAgent implements SeatAgent {
  readonly label: string;
  readonly seat: PlayerId;
  private readonly o: LlmSeatOptions;
  private state: TurnState | null = null;
  /** Increases with every round: a late completion of an older round never touches the state. */
  private token = 0;
  private prefix: {
    readonly shared: string;
    readonly seat: string;
    readonly tools: string;
  } | null = null;
  private readonly prefixTokens: number;

  constructor(o: LlmSeatOptions) {
    this.o = o;
    this.seat = o.seat;
    this.label = `llm:${o.adapter.label}:${profileRef(o.profile)}:p${PROMPT_VERSION}`;
    this.prefixTokens =
      o.prefixTokens ??
      bytesOf(o.prompt.shared) +
        bytesOf(o.prompt.seat) +
        bytesOf(JSON.stringify(o.tools)) +
        3 * ENTRY_OVERHEAD_TOKENS;
  }

  async round(input: RoundInput): Promise<RoundOutput> {
    const o = this.o;
    const where = `llm ${this.seat} turn ${input.turn} round ${input.round}`;
    if (input.seat !== this.seat) throw new AgentError(`${where}: input for ${input.seat}`);
    this.token += 1;
    const token = this.token;
    const s = this.enter(input, where);
    const t = requestTime(input);
    if (this.stopped(t)) {
      o.gate.record({ k: "turn_ok", seat: this.seat });
      return { calls: [] };
    }
    if (s.capGrant === "used" && o.ledger.wakeOver(this.seat, input.turn)) {
      // The wake's last reply was made: the turn ends.
      o.gate.record({ k: "turn_ok", seat: this.seat });
      return { calls: [] };
    }
    const deadline =
      o.policy.roundDeadlineMs === null
        ? null
        : timeoutSignal(o.clock.time, o.policy.roundDeadlineMs, "round deadline");
    try {
      const res = await this.callWithPolicy(
        s,
        { input, t, kind: "round" },
        where,
        deadline?.signal,
      );
      if (token !== this.token) return { calls: [] };
      if (res === null) {
        o.gate.record({ k: "turn_ok", seat: this.seat });
        return { calls: [] };
      }
      s.entries.push({ role: "assistant", reply: res.reply });
      s.pending = res.reply.calls.map((c) => c.callId);
      const terminal =
        res.reply.calls.length === 0 ||
        res.reply.calls.some((c) => c.name === "end_turn") ||
        input.round >= input.maxRounds - 1 ||
        s.capGrant === "used";
      let thought = terminal ? thoughtOf(res.reply.text) : undefined;
      if (terminal && thought === undefined && o.policy.thoughtCall) {
        thought = await this.thoughtCall(s, input, t, deadline?.signal);
      }
      if (terminal) o.gate.record({ k: "turn_ok", seat: this.seat });
      return {
        calls: res.reply.calls.map((c) => ({ tool: c.name, args: c.args })),
        ...(thought === undefined ? {} : { thought }),
      };
    } catch (e) {
      if (e instanceof ArenaAborted) throw e;
      const error =
        e instanceof AgentError
          ? e
          : new AgentError(
              `${where}: ${e instanceof Error ? e.message : String(e)}`,
              // A wait cut by the round deadline (backoff, rate gate) is a deadline abort.
              !(e instanceof AbortedError),
            );
      o.gate.record({
        k: "turn_error",
        seat: this.seat,
        error: error.message,
        systemic: error.systemic,
      });
      throw error;
    } finally {
      deadline?.cancel();
    }
  }

  /**
   * The seat may make no more attempts (its cap, the kill switch, the operator): its hand-off is
   * requested (idempotent) and `true` returned.
   */
  private stopped(t: GameTime): boolean {
    const why = this.o.ledger.overReason(this.seat);
    if (why === null) return false;
    this.o.ledger.requestHandoff(this.seat, why, t);
    return true;
  }

  /** The `wake_cap` line: the wake reached its soft cap; this attempt is its last. */
  private wakeCapLine(input: RoundInput, t: GameTime): void {
    const o = this.o;
    o.log.write({
      k: "wake_cap",
      seat: this.seat,
      turn: input.turn,
      round: input.round,
      t,
      wakeSpentNanoUsd: o.ledger.wakeSpent(this.seat, input.turn),
      wakeCapNanoUsd: o.ledger.wakeCap(this.seat) ?? 0,
    });
  }

  /**
   * The prompt cap: the estimate of a request with `entries` over `policy.promptCapTokens` writes
   * a `prompt_cap` line and returns the estimate; `null` when the request may be sent.
   */
  private overPromptCap(
    s: TurnState,
    w: Where,
    entries: readonly Entry[],
  ): { readonly estimate: number; readonly cap: number } | null {
    const cap = this.o.policy.promptCapTokens;
    if (cap === undefined) return null;
    const estimate = promptEstimate(entries, s.known, this.prefixTokens);
    if (estimate <= cap) return null;
    this.o.log.write({
      k: "prompt_cap",
      seat: this.seat,
      turn: w.input.turn,
      round: w.input.round,
      kind: w.kind,
      t: w.t,
      estimateTokens: estimate,
      capTokens: cap,
    });
    return { estimate, cap };
  }

  /** The turn's conversation with this round's input appended. */
  private enter(input: RoundInput, where: string): TurnState {
    if (input.round === 0) {
      const s: TurnState = {
        turn: input.turn,
        entries: [
          userOf([{ kind: "text", text: canonicalJson(input.briefing) }]),
          operatorOf(turnHeader(input)),
        ],
        pending: [],
        lastPrompt: 0,
        logged: 0,
        capGrant: "none",
        known: null,
      };
      this.state = s;
      return s;
    }
    const s = this.state;
    if (s === null || s.turn !== input.turn || s.entries.at(-1)?.role !== "assistant") {
      throw new AgentError(`${where}: no reply of round ${input.round - 1} to continue`);
    }
    if (input.results.length !== s.pending.length) {
      throw new AgentError(
        `${where}: ${input.results.length} results for ${s.pending.length} calls`,
      );
    }
    const parts: UserPart[] = input.results.map((r, i) => ({
      kind: "result",
      callId: s.pending[i] ?? "",
      content: canonicalJson(r),
      isError: !r.ok,
    }));
    // The soft cap reached and not yet used: this round's reply is the wake's last; say so.
    const wakeEnds = s.capGrant === "none" && this.o.ledger.wakeOver(this.seat, input.turn);
    s.entries.push(userOf(parts), operatorOf(roundReminder(input, wakeEnds)));
    s.pending = [];
    return s;
  }

  private meta(input: RoundInput, kind: CallMeta["kind"]): CallMeta {
    return {
      seat: this.seat,
      turn: input.turn,
      round: input.round,
      maxRounds: input.maxRounds,
      maxCalls: input.maxCalls,
      kind,
    };
  }

  /**
   * One round's model call with every policy of §2.6; `null` when no attempt may be made: the seat
   * is over its cap, or the wake's last attempt (§3.6) was already made.
   */
  private async callWithPolicy(
    s: TurnState,
    w: Where,
    where: string,
    roundSignal: AbortSignal | undefined,
  ): Promise<ChatResult | null> {
    const o = this.o;
    const spec = o.adapter.spec;
    const budget = new RetryBudget(o.clock, o.gate, o.policy.retryBudgetMs);
    const entries = [...s.entries];
    let attempt = 0;
    let retries = 0;
    let maxOutputTokens: number | undefined;
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- attempts are sequential by design
      await o.gate.open(roundSignal);
      if (this.stopped(w.t)) return null;
      if (o.ledger.wakeOver(this.seat, w.input.turn)) {
        if (s.capGrant === "used") return null;
        s.capGrant = "used";
        this.wakeCapLine(w.input, w.t);
      }
      const capped = this.overPromptCap(s, w, entries);
      if (capped !== null) {
        throw new AgentError(
          `${where}: prompt_cap (estimated ${capped.estimate} prompt tokens > ${capped.cap})`,
          false,
        );
      }
      // oxlint-disable-next-line no-await-in-loop -- one slot per attempt
      const release = await o.rate.acquire(roundSignal);
      // The kill switch may have fired while this attempt waited for its slot: none starts after it.
      if (this.stopped(w.t)) {
        release();
        return null;
      }
      attempt += 1;
      const attemptTimer = timeoutSignal(
        o.clock.time,
        o.policy.attemptTimeoutMs,
        "attempt timeout",
      );
      const signal =
        roundSignal === undefined
          ? attemptTimer.signal
          : AbortSignal.any([roundSignal, attemptTimer.signal]);
      const req: ChatRequest = {
        prompt: o.prompt,
        tools: o.tools,
        entries,
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
        signal,
        meta: this.meta(w.input, "round"),
      };
      try {
        this.logRequest(s, w, attempt, req);
      } catch (e) {
        // A transcript that cannot be written closes the turn, never holds the model's slot.
        release();
        attemptTimer.cancel();
        throw e;
      }
      const wallStart = o.clock.iso?.();
      const started = o.clock.time.nowMs();
      let res: ChatResult;
      try {
        // oxlint-disable-next-line no-await-in-loop -- the attempt itself
        res = await o.adapter.chat(req);
      } catch (e) {
        release();
        attemptTimer.cancel();
        let err = asModelError(e);
        if (
          err.kind === "aborted" &&
          attemptTimer.signal.aborted &&
          roundSignal?.aborted !== true
        ) {
          err = new ModelError(
            "timeout",
            `attempt timed out after ${o.policy.attemptTimeoutMs} ms`,
            {
              spent: err.spent,
            },
          );
        }
        const charge = o.ledger.charge(this.seat, w.input.turn, w.t, err.spent);
        this.writeCall(w, attempt, req, {
          wallStart,
          latencyMs: o.clock.time.nowMs() - started,
          charge,
          res: null,
          err,
          cacheMiss: false,
        });
        o.gate.record({ k: "attempt_failed", model: spec.model, seat: this.seat, kind: err.kind });
        const status = err.status === null ? "" : ` (${err.status})`;
        if (err.retryable) {
          if (err.kind === "rate_limit" || err.kind === "overloaded") {
            o.rate.holdFor(err.retryAfterMs ?? DEFAULT_HOLD_MS);
          }
          const wait = backoffMs(
            retries,
            err.retryAfterMs,
            () => o.clock.random(),
            o.policy.backoff ?? DEFAULT_BACKOFF,
          );
          retries += 1;
          if (!budget.allows(wait)) {
            throw new AgentError(`${where}: ${err.kind}${status}, retries exhausted`);
          }
          // oxlint-disable-next-line no-await-in-loop -- the backoff before the next attempt
          await sleepMs(o.clock.time, wait, roundSignal);
          continue;
        }
        if (isOperatorKind(err.kind)) {
          o.gate.close({
            kind: err.kind,
            message: err.message,
            seat: this.seat,
            model: spec.model,
          });
          continue;
        }
        if (err.kind === "aborted") {
          throw new AgentError(`${where}: request aborted at the round deadline`, false);
        }
        throw new AgentError(`${where}: ${err.kind}${status}`);
      }
      release();
      attemptTimer.cancel();
      const charge = o.ledger.charge(this.seat, w.input.turn, w.t, res.usage);
      o.gate.record({ k: "attempt_ok", model: spec.model });
      const served = servedTokens(res.usage);
      const share = o.policy.cacheMissShare ?? 0.8;
      const cacheMiss = s.lastPrompt > 0 && served.cacheRead < s.lastPrompt * share;
      s.lastPrompt = promptTokens(served);
      s.known = { prompt: s.lastPrompt, output: served.output, entries: entries.length };
      this.writeCall(w, attempt, req, {
        wallStart,
        latencyMs: res.latencyMs,
        charge,
        res,
        err: null,
        cacheMiss,
      });
      this.writeReply(w, attempt, res);
      this.o.log.transcript({
        k: "response",
        seat: this.seat,
        turn: w.input.turn,
        round: w.input.round,
        attempt,
        raw: res.raw,
      });
      switch (res.stop) {
        case "refusal":
          throw new AgentError(
            `${where}: refusal (${res.refusal?.category ?? "uncategorised"}) on ${res.servedBy}`,
            false,
          );
        case "max_tokens": {
          if (maxOutputTokens !== undefined) {
            throw new AgentError(`${where}: max_tokens twice`, false);
          }
          // One retry with a larger limit; none when the limit is already the model's.
          const next = retryOutputTokens(spec.maxOutputTokens);
          if (next === null) {
            throw new AgentError(`${where}: max_tokens at the model's limit`, false);
          }
          maxOutputTokens = next;
          continue;
        }
        case "pause":
        case "other":
          throw new AgentError(`${where}: unexpected stop ${res.rawStop}`);
        case "end_turn":
        case "tool_use":
          return res;
      }
    }
  }

  /**
   * The out-of-band thought call (§3.5): a terminal reply with no text gets one extra call, not a
   * gateway round. Each pending call is answered "queued" and an operator entry asks for the
   * thought; the conversation of the turn is left untouched, so a turn that goes on (a rejected
   * `end_turn`) never sees the synthetic results. Any failure just leaves the turn without thought.
   * Never over the seat's cap or the wake's; bounded by the attempt timeout like any attempt.
   */
  private async thoughtCall(
    s: TurnState,
    input: RoundInput,
    t: GameTime,
    roundSignal: AbortSignal | undefined,
  ): Promise<string | undefined> {
    const o = this.o;
    if (o.ledger.over(this.seat) || o.ledger.wakeOver(this.seat, input.turn)) return undefined;
    const parts: UserPart[] =
      s.pending.length > 0
        ? s.pending.map((callId) => ({
            kind: "result",
            callId,
            content: THOUGHT_QUEUED,
            isError: false,
          }))
        : [{ kind: "text", text: THOUGHT_QUEUED }];
    const w: Where = { input, t, kind: "thought_call" };
    const entries = [...s.entries, userOf(parts), operatorOf(THOUGHT_ASK)];
    if (this.overPromptCap(s, w, entries) !== null) return undefined;
    const attemptTimer = timeoutSignal(o.clock.time, o.policy.attemptTimeoutMs, "attempt timeout");
    const signal =
      roundSignal === undefined
        ? attemptTimer.signal
        : AbortSignal.any([roundSignal, attemptTimer.signal]);
    const req: ChatRequest = {
      prompt: o.prompt,
      tools: o.tools,
      entries,
      signal,
      meta: this.meta(input, "thought"),
    };
    let release: (() => void) | null = null;
    const started = o.clock.time.nowMs();
    const wallStart = o.clock.iso?.();
    try {
      await o.gate.open(roundSignal);
      release = await o.rate.acquire(roundSignal);
      // As for a round: no thought call starts once the seat is over its cap or halted.
      if (o.ledger.over(this.seat)) return undefined;
      this.logRequest(s, w, 1, req);
      const res = await o.adapter.chat(req);
      const charge = o.ledger.charge(this.seat, input.turn, t, res.usage);
      this.writeCall(w, 1, req, {
        wallStart,
        latencyMs: res.latencyMs,
        charge,
        res,
        err: null,
        cacheMiss: false,
      });
      this.writeReply(w, 1, res);
      return res.stop === "refusal" ? undefined : thoughtOf(res.reply.text);
    } catch (e) {
      if (e instanceof ArenaAborted) throw e;
      const err = asModelError(e);
      const charge = o.ledger.charge(this.seat, input.turn, t, err.spent);
      this.writeCall(w, 1, req, {
        wallStart,
        latencyMs: o.clock.time.nowMs() - started,
        charge,
        res: null,
        err,
        cacheMiss: false,
      });
      return undefined;
    } finally {
      release?.();
      attemptTimer.cancel();
    }
  }

  // Logs ------------------------------------------------------------------------------------------

  private prefixHashes(): {
    readonly shared: string;
    readonly seat: string;
    readonly tools: string;
  } {
    this.prefix ??= {
      shared: sha256Hex(this.o.prompt.shared),
      seat: sha256Hex(this.o.prompt.seat),
      tools: sha256Hex(JSON.stringify(this.o.tools)),
    };
    return this.prefix;
  }

  private logRequest(s: TurnState, w: Where, attempt: number, req: ChatRequest): void {
    this.o.log.transcript({
      k: "request",
      seat: this.seat,
      turn: w.input.turn,
      round: w.input.round,
      attempt,
      kind: w.kind,
      prefix: this.prefixHashes(),
      from: s.logged,
      entries: req.entries.slice(s.logged),
      maxOutputTokens: req.maxOutputTokens ?? this.o.adapter.spec.maxOutputTokens,
    });
    if (w.kind === "round") s.logged = req.entries.length;
  }

  /** The `replies.jsonl` line of a reply that arrived, right after its `llm_call` line. */
  private writeReply(w: Where, attempt: number, res: ChatResult): void {
    const line = replyLine(
      {
        seat: this.seat,
        turn: w.input.turn,
        round: w.input.round,
        attempt,
        kind: w.kind,
        t: w.t,
      },
      res,
    );
    if (line !== null) this.o.log.reply(line);
  }

  private writeCall(
    w: Where,
    attempt: number,
    req: ChatRequest,
    r: {
      readonly wallStart: string | undefined;
      readonly latencyMs: number;
      readonly charge: Charge;
      readonly res: ChatResult | null;
      readonly err: ModelError | null;
      readonly cacheMiss: boolean;
    },
  ): void {
    const spec = this.o.adapter.spec;
    const usage: readonly UsageEntry[] = r.res?.usage ?? r.err?.spent ?? [];
    const res = r.res;
    const line: LlmCallLine = {
      k: "llm_call",
      seat: this.seat,
      turn: w.input.turn,
      round: w.input.round,
      attempt,
      kind: w.kind,
      t: w.t,
      ...(r.wallStart === undefined ? {} : { wallStart: r.wallStart }),
      latencyMs: Math.max(0, Math.floor(r.latencyMs)),
      ttftMs: res?.ttftMs ?? null,
      provider: spec.provider,
      model: spec.model,
      servedBy: res?.servedBy ?? null,
      effort: spec.effort,
      maxTokens: req.maxOutputTokens ?? spec.maxOutputTokens,
      stop: res?.stop ?? "error",
      rawStop: res?.rawStop ?? null,
      refusal: res?.refusal ?? null,
      fallback: res?.fallback ?? false,
      cacheMiss: r.cacheMiss,
      usage: usage.map((u) => ({
        model: u.model,
        kind: u.kind,
        input: u.tokens.input,
        cacheWrite5m: u.tokens.cacheWrite5m,
        cacheWrite1h: u.tokens.cacheWrite1h,
        cacheRead: u.tokens.cacheRead,
        output: u.tokens.output,
        estimated: u.estimated,
      })),
      costNanoUsd: r.charge.costNanoUsd,
      seatSpentNanoUsd: r.charge.seatSpentNanoUsd,
      capNanoUsd: r.charge.capNanoUsd,
      wakeSpentNanoUsd: r.charge.wakeSpentNanoUsd,
      unpriced: [...r.charge.unpriced],
      calls: res?.reply.calls.length ?? 0,
      textChars: res?.reply.text.reduce((n, x) => n + x.length, 0) ?? 0,
      reasoningChars: res?.reply.reasoning.reduce((n, x) => n + x.length, 0) ?? 0,
      requestId: res?.requestId ?? r.err?.requestId ?? null,
      error:
        r.err === null ? null : { kind: r.err.kind, status: r.err.status, message: r.err.message },
      // A refusal names the turn's inbox: a player's message can be what tripped it (§3.8).
      ...(res?.stop === "refusal" ? { inbox: w.input.briefing.msgs.map((m) => m.id) } : {}),
    };
    this.o.log.write(line);
    if (r.err !== null) {
      this.o.log.transcript({
        k: "error",
        seat: this.seat,
        turn: w.input.turn,
        round: w.input.round,
        attempt,
        error: { kind: r.err.kind, message: r.err.message },
      });
    }
  }
}
