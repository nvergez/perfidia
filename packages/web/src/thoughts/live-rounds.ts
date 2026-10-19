import type { TurnAnnotation } from "@perfidia/protocol/spectator";
import type { AnnotMsg } from "../store/match.ts";
import { shapeRounds, type RoundRow } from "../turns/detail.ts";

// The live reasoning's view of an open turn (phase-3 design §4.2 Pass C, C3): the rounds the live
// socket brought (`annot` messages; one per round, a resent round replacing the earlier one, the
// thought call last), the newest few shown and the earlier ones counted, until "more"; and the
// hand-over of those rounds to the closed turn's reasoning. Pure.

/** Rounds shown before "more": the newest. */
export const LIVE_ROUNDS_SHOWN = 3;

export interface LiveView {
  /** The rounds to show, oldest first. */
  readonly rounds: readonly RoundRow[];
  /** Rounds held but not shown (before "more"). */
  readonly earlier: number;
  /** The newest round's key (shown at full length; the others in one line until "more"). */
  readonly latest: string | null;
}

export function liveView(msgs: readonly AnnotMsg[], expanded: boolean): LiveView {
  const all = shapeRounds({ annotation: null, live: msgs, results: null }).rounds;
  const rounds = expanded ? all : all.slice(-LIVE_ROUNDS_SHOWN);
  return { rounds, earlier: all.length - rounds.length, latest: all.at(-1)?.key ?? null };
}

/** The newest round (0-based) the live socket brought for a turn, null when none. */
export function liveTopRound(msgs: readonly AnnotMsg[]): number | null {
  let top: number | null = null;
  for (const m of msgs) if (m.kind === "round" && (top === null || m.round > top)) top = m.round;
  return top;
}

/** The round a seat is in: the newer of the log's (its last call's) and the live socket's. */
export function roundNow(logged: number | null, live: number | null): number | null {
  if (logged === null) return live;
  return live === null ? logged : Math.max(logged, live);
}

type Round = TurnAnnotation["rounds"][number];

const byRound = (a: Round, b: Round): number =>
  a.kind !== b.kind ? (a.kind === "round" ? -1 : 1) : a.round - b.round;

/**
 * A turn's annotation with the rounds the live socket brought joined in (the hand-over when a turn
 * ends: its reasoning shows at once, before or while the annotation is fetched again): a live round
 * replaces the reasoning, text and tools of the same round, a round the annotation lacks is added
 * with no figures. Null when neither has anything.
 */
export function withLive(
  seat: TurnAnnotation["seat"],
  turn: number,
  a: TurnAnnotation | null,
  live: readonly AnnotMsg[],
): TurnAnnotation | null {
  if (live.length === 0) return a;
  const rounds = [...(a?.rounds ?? [])];
  for (const m of live) {
    const at = rounds.findIndex((r) => r.round === m.round && r.kind === m.kind);
    const held = rounds[at];
    const round: Round = {
      ...(held ?? {
        round: m.round,
        kind: m.kind,
        attempts: 0,
        stop: null,
        refusal: null,
        errors: [],
        costNanoUsd: 0,
        tokens: { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 },
        latencyMs: 0,
      }),
      reasoning: m.reasoning,
      text: m.text,
      calls: m.calls,
    };
    if (held === undefined) rounds.push(round);
    else rounds[at] = round;
  }
  return {
    seat,
    turn,
    complete: a?.complete ?? false,
    rounds: rounds.toSorted(byRound),
    spentNanoUsd: a?.spentNanoUsd ?? null,
    capNanoUsd: a?.capNanoUsd ?? null,
  };
}
