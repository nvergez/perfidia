import type { ActLine, ErrorCode, GwLine, TurnLine, WakeKind } from "@perfidia/protocol";
import { rollDay, seatOf } from "./state.ts";
import type {
  GatewayState,
  LastTurn,
  NextWake,
  SeatState,
  TurnFailure,
  UnseenFailure,
  WakeScheduler,
} from "./types.ts";

// Turn bookkeeping driven by the `act`, `gw` and `turn` lines (§8.4, §10.5): daily counters, the
// failures of the turn in progress, and `lastTurn` when the turn closes. The `message` of a failure
// is the explanation the agent got (or would have got): the live host passes the `ToolResult`'s,
// the rebuild re-explains the violation that the engine re-run supplies. `recordAct`, `recordGw`
// and `closeTurn` are the `act`, `gw` and `turn` folds of §10.5, which describes them in words
// ("daily counters and the round's failures", "end, selfAt and lastTurn") rather than by name.

/** Codes listed in `lastTurn.unseen` whatever the round: calls that never ran. */
const alwaysUnseen = (code: ErrorCode): boolean => code === "TURN_OVER" || code === "CALLS_CAP";

/**
 * Records a failure of the turn in progress. The failures of earlier rounds were shown to the
 * agent in the next round, so they are dropped (the always-unseen codes aside), and a repeated
 * `TURN_OVER` or `CALLS_CAP` only counts on its code's first entry: the list stays bounded by the
 * failures of one round, whose calls are capped, plus two entries, however many calls an agent
 * sends. The folding is a deviation from §8.2, which lists each such call.
 */
function addFailure(s: SeatState, f: Omit<TurnFailure, "count">): void {
  if (alwaysUnseen(f.code)) {
    const same = s.turnFailures.find((x) => x.code === f.code);
    if (same !== undefined) {
      same.count += 1;
      return;
    }
  }
  s.turnFailures = s.turnFailures.filter((x) => x.round >= f.round || alwaysUnseen(x.code));
  s.turnFailures.push({ ...f, count: 1 });
}

function unseen({ tool, code, message, count }: TurnFailure): UnseenFailure {
  return count > 1 ? { tool, code, message, count } : { tool, code, message };
}

/**
 * An `act` line: an engine-accepted `attack` counts one launch and an accepted `send_message`
 * one message (one call counts once), on the game day of the line; a rejection is a failure of
 * the turn. `message` is required for rejections.
 */
export function recordAct(
  gw: GatewayState,
  line: Pick<ActLine, "t" | "seat" | "rt" | "tool" | "a" | "r">,
  message: string | null,
): void {
  const s = seatOf(gw, line.seat);
  if (line.r.ok) {
    if (line.a.type === "attack") rollDay(s, line.t).attacks += 1;
    else if (line.a.type === "send_message") rollDay(s, line.t).messages += 1;
    return;
  }
  addFailure(s, {
    round: line.rt,
    tool: line.tool,
    code: line.r.code,
    message: message ?? line.r.code,
  });
}

/** A `gw` line: a call the gateway rejected (or `INTERNAL`) is a failure of the turn. */
export function recordGw(
  gw: GatewayState,
  line: Pick<GwLine, "seat" | "rt" | "tool" | "r">,
  message: string,
): void {
  addFailure(seatOf(gw, line.seat), {
    round: line.rt,
    tool: line.tool,
    code: line.r.code,
    message,
  });
}

function asTurnNext(next: NextWake | null): LastTurn["nextWake"] {
  if (next === null) return null;
  if (next.kind === "start") throw new Error("a closed turn cannot have the start wake pending");
  const kind: WakeKind = next.kind;
  return { at: next.at, kind };
}

/**
 * A `turn` line: the scheduler ends the turn at `t` (it throws, changing nothing, when the seat is
 * not in a turn), the pending self-wake becomes `selfAt`, and `lastTurn` records how the turn
 * ended, the failures the agent never saw (those of round `rounds - 1`, the last, and the
 * `TURN_OVER` and `CALLS_CAP` entries) and the effective next wake.
 *
 * `next` is the line's next wake when known (the rebuild, or a host that writes `null` because the
 * match ended); otherwise it is the scheduler's next wake after the end. The return value is what
 * the `turn` line records.
 */
export function closeTurn(
  gw: GatewayState,
  wake: WakeScheduler,
  line: Pick<TurnLine, "t" | "seat" | "why" | "rounds" | "selfAt"> & {
    next?: TurnLine["next"];
  },
): Pick<TurnLine, "selfAt" | "next"> {
  const s = seatOf(gw, line.seat);
  wake.end(line.seat, line.t);
  s.wake.selfAt = line.selfAt;
  const next = line.next === undefined ? asTurnNext(wake.peek(line.seat)) : line.next;
  const last = line.rounds - 1;
  s.lastTurn = {
    ended: line.why,
    unseen: s.turnFailures.filter((f) => f.round >= last || alwaysUnseen(f.code)).map(unseen),
    nextWake: next === null ? null : { at: next.at, kind: next.kind },
  };
  s.turnFailures = [];
  return { selfAt: s.wake.selfAt, next: next === null ? null : { at: next.at, kind: next.kind } };
}
