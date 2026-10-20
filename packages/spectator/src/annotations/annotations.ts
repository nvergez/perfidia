import type {
  AnnotationRound,
  LlmLogLine,
  PlayerId,
  ReplyLine,
  TurnAnnotation,
} from "@perfidia/protocol";
import { LABEL_MAX_CHARS, TOOL_NAME_MAX_CHARS, cleanText, cutText } from "../clean.ts";

// The annotations of LLM turns (phase-3 design §2.7): a pure fold of the side files
// `llm_calls.jsonl` and `replies.jsonl`, keyed by `(seat, turn)`, never part of the steps (side
// lines can land after the `turn` line, and steps depend on `match.jsonl` alone). Per round (and
// thought call): the attempts, the last stop, the refusal category, the error kinds, the reply's
// reasoning summaries, text and tool names, cost, tokens and latency; per turn, the seat's spend
// after it and its cap. A turn is `complete` once a side line of a later turn of the same seat
// exists, or the run is over (`final`). What is never kept: request ids, error messages, refusal
// explanations, wall times. Text is cleaned (`cleanText`), tool names and labels cut to 64
// characters. Costs and reasoning can be left out (`AnnotationPolicy`).

export interface AnnotationPolicy {
  /** Cost, tokens, model time, spend and cap (default true: the design serves them, §2.6). */
  readonly costs: boolean;
  /** Reasoning summaries and reply text (default true). */
  readonly reasoning: boolean;
}

export const DEFAULT_POLICY: AnnotationPolicy = Object.freeze({ costs: true, reasoning: true });

export interface Handoff {
  readonly t: number;
  readonly label: string;
  readonly reason: string;
}

export interface AnnotationFold {
  /**
   * One line of `llm_calls.jsonl` (`llm_call`, `handoff`, `pause` or `wake_cap`). Phase 4's
   * `preflight`, `prompt_cap`, `kill_switch`, `operator` and `carry` lines are accepted and change
   * no annotation; a hand-off keeps its reason (`cap`, `match_budget`, `outage`, `operator`).
   */
  call(line: LlmLogLine): void;
  /** One line of `replies.jsonl`. */
  reply(line: ReplyLine): void;
  /** The annotation of a turn, or null when no side line names it. */
  turn(seat: PlayerId, turn: number, o?: { readonly final?: boolean }): TurnAnnotation | null;
  /** The turns of a seat with an annotation, in order. */
  turns(seat: PlayerId): number[];
  /** A seat's spend so far and its cap (null when costs are not public or nothing was spent). */
  spend(seat: PlayerId): { readonly spentNanoUsd: number; readonly capNanoUsd: number } | null;
  /** A seat's hand-off to its bot, from `llm_calls.jsonl`. */
  handoff(seat: PlayerId): Handoff | null;
}

interface RoundAcc {
  readonly round: number;
  readonly kind: "round" | "thought_call";
  attempts: number;
  stop: string | null;
  refusal: string | null;
  readonly errors: string[];
  reasoning: string[];
  text: string[];
  calls: string[];
  costNanoUsd: number;
  readonly tokens: {
    input: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
    cacheRead: number;
    output: number;
  };
  latencyMs: number;
}

interface TurnAcc {
  readonly rounds: Map<string, RoundAcc>;
  spentNanoUsd: number;
  capNanoUsd: number;
}

const roundKey = (round: number, kind: string): string => `${kind}:${round}`;

/** A label from the harness's log (a refusal's category, an error's kind), cleaned and cut. */
function labelOf(label: string | null, none: string): string {
  const out = cutText(cleanText(label ?? ""), LABEL_MAX_CHARS).trim();
  return out === "" ? none : out;
}

class Annotations implements AnnotationFold {
  private readonly policy: AnnotationPolicy;
  private readonly bySeat = new Map<PlayerId, Map<number, TurnAcc>>();
  private readonly lastTurn = new Map<PlayerId, number>();
  private readonly spent = new Map<PlayerId, { spentNanoUsd: number; capNanoUsd: number }>();
  private readonly handoffs = new Map<PlayerId, Handoff>();

  constructor(policy: AnnotationPolicy) {
    this.policy = policy;
  }

  call(line: LlmLogLine): void {
    if (line.k === "handoff") {
      this.handoffs.set(line.seat, { t: line.t, label: line.label, reason: line.reason });
      return;
    }
    if (line.k !== "llm_call") return;
    const turn = this.turnAcc(line.seat, line.turn);
    const r = this.roundAcc(turn, line.round, line.kind);
    r.attempts += 1;
    r.stop = line.stop;
    if (line.stop === "refusal")
      r.refusal = labelOf(line.refusal?.category ?? null, "uncategorised");
    if (line.error !== null) r.errors.push(labelOf(line.error.kind, "unknown"));
    r.costNanoUsd += line.costNanoUsd;
    for (const u of line.usage) {
      r.tokens.input += u.input;
      r.tokens.cacheWrite5m += u.cacheWrite5m;
      r.tokens.cacheWrite1h += u.cacheWrite1h;
      r.tokens.cacheRead += u.cacheRead;
      r.tokens.output += u.output;
    }
    r.latencyMs += line.latencyMs;
    turn.spentNanoUsd = Math.max(turn.spentNanoUsd, line.seatSpentNanoUsd);
    turn.capNanoUsd = line.capNanoUsd;
    this.spent.set(line.seat, { spentNanoUsd: line.seatSpentNanoUsd, capNanoUsd: line.capNanoUsd });
  }

  reply(line: ReplyLine): void {
    const r = this.roundAcc(this.turnAcc(line.seat, line.turn), line.round, line.kind);
    r.reasoning = line.reasoning.map(cleanText);
    r.text = line.text.map(cleanText);
    r.calls = line.calls.map((c) => cutText(cleanText(c.name), TOOL_NAME_MAX_CHARS));
  }

  turn(seat: PlayerId, turn: number, o: { readonly final?: boolean } = {}): TurnAnnotation | null {
    const acc = this.bySeat.get(seat)?.get(turn);
    if (acc === undefined) return null;
    const costs = this.policy.costs;
    const reasoning = this.policy.reasoning;
    const rounds: AnnotationRound[] = [...acc.rounds.values()]
      .toSorted((a, b) => a.round - b.round || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0))
      .map((r) => ({
        round: r.round,
        kind: r.kind,
        attempts: r.attempts,
        stop: r.stop,
        refusal: r.refusal,
        errors: [...r.errors],
        reasoning: reasoning ? [...r.reasoning] : [],
        text: reasoning ? [...r.text] : [],
        calls: [...r.calls],
        costNanoUsd: costs ? r.costNanoUsd : 0,
        tokens: costs
          ? { ...r.tokens }
          : { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 },
        latencyMs: costs ? r.latencyMs : 0,
      }));
    const later = (this.lastTurn.get(seat) ?? 0) > turn;
    return {
      seat,
      turn,
      complete: o.final === true || later,
      rounds,
      spentNanoUsd: costs && acc.spentNanoUsd > 0 ? acc.spentNanoUsd : null,
      capNanoUsd: costs && acc.capNanoUsd > 0 ? acc.capNanoUsd : null,
    };
  }

  turns(seat: PlayerId): number[] {
    return [...(this.bySeat.get(seat)?.keys() ?? [])].toSorted((a, b) => a - b);
  }

  spend(seat: PlayerId): { readonly spentNanoUsd: number; readonly capNanoUsd: number } | null {
    if (!this.policy.costs) return null;
    return this.spent.get(seat) ?? null;
  }

  handoff(seat: PlayerId): Handoff | null {
    return this.handoffs.get(seat) ?? null;
  }

  private turnAcc(seat: PlayerId, turn: number): TurnAcc {
    let turns = this.bySeat.get(seat);
    if (turns === undefined) {
      turns = new Map();
      this.bySeat.set(seat, turns);
    }
    let acc = turns.get(turn);
    if (acc === undefined) {
      acc = { rounds: new Map(), spentNanoUsd: 0, capNanoUsd: 0 };
      turns.set(turn, acc);
    }
    this.lastTurn.set(seat, Math.max(this.lastTurn.get(seat) ?? 0, turn));
    return acc;
  }

  private roundAcc(turn: TurnAcc, round: number, kind: "round" | "thought_call"): RoundAcc {
    const key = roundKey(round, kind);
    let r = turn.rounds.get(key);
    if (r === undefined) {
      r = {
        round,
        kind,
        attempts: 0,
        stop: null,
        refusal: null,
        errors: [],
        reasoning: [],
        text: [],
        calls: [],
        costNanoUsd: 0,
        tokens: { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 },
        latencyMs: 0,
      };
      turn.rounds.set(key, r);
    }
    return r;
  }
}

/** A new annotation fold; feed it the side lines in file order (each file's order is enough). */
export function createAnnotationFold(policy: AnnotationPolicy = DEFAULT_POLICY): AnnotationFold {
  return new Annotations(policy);
}
