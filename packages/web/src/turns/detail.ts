import type {
  AnnotationRound,
  FeedItemOf,
  TurnAnnotation,
  TurnCall,
} from "@perfidia/protocol/spectator";
import type { FeedEntry } from "../playback/timeline.ts";
import type { AnnotMsg } from "../store/match.ts";

// The turn detail's data, shaped (phase-3 design §4.2 Pass C; docs/phase3.md §16.4, §16.7): pure,
// no React. A turn's rounds come from three sources, each partial:
// - the annotation route (`TurnAnnotation`): every round's reasoning, text and tool names, with its
//   attempts, stop, cost, tokens and latency (zeros and empty lists where the server publishes
//   none);
// - the live socket (`annot` messages, `useLiveAnnots`): the rounds of an open turn as their replies
//   arrive (reasoning, text, tool names; no cost), newer than an annotation fetched before them;
// - the closed turn's feed item (`TurnItem.results`): each call's verdict and rejection codes from
//   `match.jsonl`, in log order, with its round (`rt`; `null` for an accepted `write_note`).
// `shapeRounds` joins them round by round; the views only lay them out.

type TurnItem = FeedItemOf<"turn">;
export type TurnEnd = TurnItem["why"];
type Kind = AnnotationRound["kind"];
type Tokens = AnnotationRound["tokens"];

/** ✓ every item accepted, ✗ none, partly (a batch), … not known yet (open turn), ? no log line. */
export type Verdict = "ok" | "rejected" | "partial" | "pending" | "unknown";

export interface CallRow {
  readonly key: string;
  readonly tool: string;
  /** Items of the call (a batch has several; one otherwise). */
  readonly items: number;
  /** Items the gateway and the engine accepted. */
  readonly ok: number;
  /** Rejection codes, each once, in order (never the error text: not served). */
  readonly codes: readonly string[];
  readonly verdict: Verdict;
  /** An accepted `end_turn`, which writes no log line: accepted by its absence. */
  readonly implicit: boolean;
}

/** A round's figures from the annotation route (none for a round only the live socket brought). */
export interface RoundMeter {
  readonly attempts: number;
  readonly stop: string | null;
  readonly refusal: string | null;
  readonly errors: readonly string[];
  readonly costNanoUsd: number;
  readonly tokens: Tokens;
  readonly latencyMs: number;
}

export interface RoundRow {
  /** `round:0`, `thought_call:0`. */
  readonly key: string;
  /** 0-based, as logged ("Round 1" is round 0). */
  readonly round: number;
  readonly kind: Kind;
  readonly reasoning: readonly string[];
  readonly text: readonly string[];
  readonly calls: readonly CallRow[];
  readonly meter: RoundMeter | null;
}

export interface TurnTotals {
  readonly costNanoUsd: number;
  readonly tokens: Tokens;
  readonly latencyMs: number;
  readonly attempts: number;
  /** Rounds with figures from the annotation route. */
  readonly metered: number;
}

export interface TurnRounds {
  readonly rounds: readonly RoundRow[];
  /** The calls' verdicts are known (a closed turn's results). */
  readonly verdicts: boolean;
  readonly totals: TurnTotals;
}

export interface RoundSources {
  readonly annotation: TurnAnnotation | null;
  /** The turn's live `annot` messages, in arrival order. */
  readonly live: readonly AnnotMsg[];
  /** The closed turn's results; `null` while the turn is open or for a bot's turn. */
  readonly results: readonly TurnCall[] | null;
}

/** The longest tool name the fold keeps in a turn's results (`TOOL_NAME_MAX_CHARS`). */
const TOOL_NAME_MAX = 64;

/** A tool name as the fold cuts it (no half surrogate pair). */
function cutName(name: string): string {
  if (name.length <= TOOL_NAME_MAX) return name;
  const last = name.charCodeAt(TOOL_NAME_MAX - 1);
  return name.slice(0, last >= 0xd800 && last <= 0xdbff ? TOOL_NAME_MAX - 1 : TOOL_NAME_MAX);
}

const END_TURN = "end_turn";
const ZERO_TOKENS: Tokens = Object.freeze({
  input: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cacheRead: 0,
  output: 0,
});

export const roundKey = (kind: Kind, round: number): string => `${kind}:${round}`;

/** Rounds first, by number, then the out-of-band thought calls (asked at the turn's end). */
function byRound(
  a: { readonly kind: Kind; readonly round: number },
  b: { readonly kind: Kind; readonly round: number },
): number {
  if (a.kind !== b.kind) return a.kind === "round" ? -1 : 1;
  return a.round - b.round;
}

export function verdictOf(c: Pick<TurnCall, "items" | "ok">): Verdict {
  if (c.ok >= c.items) return "ok";
  return c.ok === 0 ? "rejected" : "partial";
}

interface Base {
  readonly round: number;
  readonly kind: Kind;
  reasoning: readonly string[];
  text: readonly string[];
  names: readonly string[];
  meter: RoundMeter | null;
}

function meterOf(r: AnnotationRound): RoundMeter {
  return {
    attempts: r.attempts,
    stop: r.stop,
    refusal: r.refusal,
    errors: r.errors,
    costNanoUsd: r.costNanoUsd,
    tokens: r.tokens,
    latencyMs: r.latencyMs,
  };
}

/**
 * The rounds of the annotation and of the live socket, one per `(kind, round)`: a live round's
 * reasoning, text and tools win (a reply resent for a retried attempt replaces the earlier one, and
 * a live message is never older than the annotation fetched before it), the figures come from the
 * annotation. Sorted: rounds by number, then thought calls.
 */
function baseRounds(annotation: TurnAnnotation | null, live: readonly AnnotMsg[]): Base[] {
  const out = new Map<string, Base>();
  for (const r of annotation?.rounds ?? []) {
    out.set(roundKey(r.kind, r.round), {
      round: r.round,
      kind: r.kind,
      reasoning: r.reasoning,
      text: r.text,
      names: r.calls,
      meter: meterOf(r),
    });
  }
  for (const m of live) {
    const key = roundKey(m.kind, m.round);
    const held = out.get(key);
    if (held === undefined) {
      out.set(key, {
        round: m.round,
        kind: m.kind,
        reasoning: m.reasoning,
        text: m.text,
        names: m.calls,
        meter: null,
      });
    } else {
      held.reasoning = m.reasoning;
      held.text = m.text;
      held.names = m.calls;
    }
  }
  return [...out.values()].toSorted(byRound);
}

const count = (xs: readonly string[], x: string): number => xs.filter((y) => y === x).length;

/**
 * The round of each result: its `rt`, or, for an accepted `write_note` (whose `note` line has no
 * `rt`), the first round from the previous call's round on whose reply names that tool more often
 * than calls already placed there; failing that, the previous call's round (null before any).
 */
function placeResults(rounds: readonly Base[], results: readonly TurnCall[]): (number | null)[] {
  const placed: (number | null)[] = [];
  const used = new Map<string, number>();
  const take = (rt: number, tool: string): void => {
    const k = `${rt}|${tool}`;
    used.set(k, (used.get(k) ?? 0) + 1);
  };
  let prev: number | null = null;
  for (const r of results) {
    let rt: number | null = r.rt;
    if (rt === null) {
      const from: number = prev ?? Number.NEGATIVE_INFINITY;
      const fit: Base | undefined = rounds.find(
        (b) =>
          b.kind === "round" &&
          b.round >= from &&
          count(b.names.map(cutName), r.tool) > (used.get(`${b.round}|${r.tool}`) ?? 0),
      );
      rt = fit?.round ?? prev;
    }
    if (rt !== null) take(rt, r.tool);
    placed.push(rt);
    prev = rt ?? prev;
  }
  return placed;
}

function rowOf(key: string, r: TurnCall): CallRow {
  return {
    key,
    tool: r.tool,
    items: r.items,
    ok: r.ok,
    codes: r.codes,
    verdict: verdictOf(r),
    implicit: false,
  };
}

function nameRow(key: string, tool: string, verdict: Verdict): CallRow {
  const implicit = tool === END_TURN && verdict === "ok";
  return { key, tool, items: 1, ok: implicit ? 1 : 0, codes: [], verdict, implicit };
}

/**
 * A turn's rounds with their calls and verdicts (see the file's header). With `results`, each round's
 * reply names are matched in order with the calls the log placed in that round; an `end_turn` with
 * no line was accepted; a call the log has but no reply names (or a round without an annotation)
 * is listed in its round all the same. Without `results` (an open turn), every call is pending.
 */
export function shapeRounds({ annotation, live, results }: RoundSources): TurnRounds {
  const bases = baseRounds(annotation, live);
  const rows: RoundRow[] = [];
  if (results === null) {
    for (const b of bases) {
      rows.push({
        key: roundKey(b.kind, b.round),
        round: b.round,
        kind: b.kind,
        reasoning: b.reasoning,
        text: b.text,
        calls: b.names.map((n, i) => nameRow(`${i}`, n, "pending")),
        meter: b.meter,
      });
    }
    return { rounds: rows, verdicts: false, totals: totalsOf(rows) };
  }
  const rts = placeResults(bases, results);
  // Results by round, in log order (a result placed nowhere goes with no round: kept apart).
  const byRt = new Map<number | null, TurnCall[]>();
  results.forEach((r, i) => {
    const rt = rts[i] ?? null;
    const list = byRt.get(rt);
    if (list === undefined) byRt.set(rt, [r]);
    else list.push(r);
  });
  const all = [...bases];
  // A round the log has calls for but no annotation or live message names (e.g. no side files).
  for (const rt of byRt.keys()) {
    if (rt !== null && !all.some((b) => b.kind === "round" && b.round === rt)) {
      all.push({ round: rt, kind: "round", reasoning: [], text: [], names: [], meter: null });
    }
  }
  all.sort(byRound);
  for (const b of all) {
    const calls: CallRow[] = [];
    if (b.kind === "round") {
      const pool = [...(byRt.get(b.round) ?? [])];
      for (const [i, name] of b.names.entries()) {
        const at = pool.findIndex((r) => r.tool === cutName(name));
        const hit = at < 0 ? undefined : pool.splice(at, 1)[0];
        if (hit !== undefined) calls.push(rowOf(`${i}`, hit));
        else calls.push(nameRow(`${i}`, name, name === END_TURN ? "ok" : "unknown"));
      }
      for (const [i, r] of pool.entries()) calls.push(rowOf(`x${i}`, r));
    } else {
      for (const [i, name] of b.names.entries()) calls.push(nameRow(`${i}`, name, "unknown"));
    }
    rows.push({
      key: roundKey(b.kind, b.round),
      round: b.round,
      kind: b.kind,
      reasoning: b.reasoning,
      text: b.text,
      calls,
      meter: b.meter,
    });
  }
  const loose = byRt.get(null) ?? [];
  if (loose.length > 0) {
    // Calls placed in no round (a turn whose only line has no round): one row of their own.
    rows.push({
      key: "loose",
      round: -1,
      kind: "round",
      reasoning: [],
      text: [],
      calls: loose.map((r, i) => rowOf(`l${i}`, r)),
      meter: null,
    });
  }
  return { rounds: rows, verdicts: true, totals: totalsOf(rows) };
}

/**
 * An open turn replayed with the playhead inside it: the rounds the log has reached (`upTo`, the
 * round of the seat's last logged call; null before any), with their totals, and the cost of the
 * rounds left out (later rounds, the closing thought call): the seat's spend after the turn less
 * that cost is its spend at the playhead.
 */
export function roundsUpTo(
  all: TurnRounds,
  upTo: number | null,
): TurnRounds & { readonly laterCostNanoUsd: number } {
  const kept: RoundRow[] = [];
  let later = 0;
  for (const r of all.rounds) {
    if (r.kind === "round" && upTo !== null && r.round <= upTo) kept.push(r);
    else later += r.meter?.costNanoUsd ?? 0;
  }
  return { ...all, rounds: kept, totals: totalsOf(kept), laterCostNanoUsd: later };
}

export function totalsOf(rows: readonly RoundRow[]): TurnTotals {
  const tokens = { ...ZERO_TOKENS };
  let costNanoUsd = 0;
  let latencyMs = 0;
  let attempts = 0;
  let metered = 0;
  for (const r of rows) {
    const m = r.meter;
    if (m === null) continue;
    metered += 1;
    costNanoUsd += m.costNanoUsd;
    latencyMs += m.latencyMs;
    attempts += m.attempts;
    tokens.input += m.tokens.input;
    tokens.cacheWrite5m += m.tokens.cacheWrite5m;
    tokens.cacheWrite1h += m.tokens.cacheWrite1h;
    tokens.cacheRead += m.tokens.cacheRead;
    tokens.output += m.tokens.output;
  }
  return { costNanoUsd, tokens, latencyMs, attempts, metered };
}

/** Every token of a count, prompt and output. */
export function tokenSum(t: Tokens): number {
  return t.input + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead + t.output;
}

/** The calls of a set of rows by verdict (a batch is one call, partly accepted or not). */
export function callTally(rows: readonly RoundRow[]): {
  readonly calls: number;
  readonly accepted: number;
  readonly partial: number;
  readonly rejected: number;
  readonly pending: number;
} {
  const n = { calls: 0, accepted: 0, partial: 0, rejected: 0, pending: 0 };
  for (const r of rows) {
    for (const c of r.calls) {
      n.calls += 1;
      if (c.verdict === "ok") n.accepted += 1;
      else if (c.verdict === "partial") n.partial += 1;
      else if (c.verdict === "rejected") n.rejected += 1;
      else n.pending += 1;
    }
  }
  return n;
}

/** "Round 2" (rounds are logged from 0), "Closing thought", "Other calls". */
export function roundTitle(r: Pick<RoundRow, "key" | "kind" | "round">): string {
  if (r.key === "loose") return "Other calls";
  return r.kind === "thought_call" ? "Closing thought" : `Round ${r.round + 1}`;
}

const WHY: Readonly<Record<TurnEnd, string>> = Object.freeze({
  end_turn: "It ended its turn itself (end_turn).",
  empty_round: "A round without a tool call ended it.",
  round_cap: "It reached the cap on rounds per turn.",
  timeout: "It ran out of time.",
  error: "An error of the model or the harness ended it.",
  match_ended: "The match ended during the turn.",
  eliminated: "The player was eliminated during the turn.",
});

/** How a turn ended, in a sentence. */
export function whyWords(why: TurnEnd): string {
  return WHY[why];
}

/** `0.8 s`, `12 s`, `3 min 5 s`: a round's or a turn's model time. */
export function fmtLatency(ms: number): string {
  if (ms < 10_000) return `${(Math.round(ms / 100) / 10).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return s % 60 === 0 ? `${m} min` : `${m} min ${s % 60} s`;
}

/** The feed's item of a seat's turn (null: not reached at the playhead, or still open). */
export function findTurnItem(
  feed: readonly FeedEntry[],
  seat: string,
  turn: number,
): { readonly seq: number; readonly item: TurnItem } | null {
  for (let i = feed.length - 1; i >= 0; i -= 1) {
    const e = feed[i];
    const it = e?.item;
    if (e !== undefined && it?.k === "turn" && it.seat === seat && it.turn === turn) {
      return { seq: e.seq, item: it };
    }
  }
  return null;
}

/**
 * The messages a seat sent in a turn, from the feed up to the playhead: those the turn's item names,
 * and (for an open turn, whose item has not come) those tagged with the turn. In log order.
 */
export function turnMessages(
  feed: readonly FeedEntry[],
  seat: string,
  turn: number,
  ids: readonly string[] = [],
): FeedItemOf<"message">[] {
  const out: FeedItemOf<"message">[] = [];
  for (const e of feed) {
    const it = e.item;
    if (it.k !== "message" || it.from !== seat) continue;
    if (it.turn === turn || ids.includes(it.message)) out.push(it);
  }
  return out;
}
