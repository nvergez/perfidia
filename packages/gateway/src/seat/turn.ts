import type { ActLine, ErrorCode, GwLine, TurnLine, WakeKind } from "@perfidia/protocol";
import { rollDay, seatOf } from "./state.ts";
import type { GatewayState, LastTurn, NextWake, WakeScheduler } from "./types.ts";

// Turn bookkeeping driven by the `act`, `gw` and `turn` lines (§8.4, §10.5): daily counters, the
// failures of the turn in progress, and `lastTurn` when the turn closes. The `message` of a failure
// is the explanation the agent got (or would have got): the live host passes the `ToolResult`'s,
// the rebuild re-explains the violation that the engine re-run supplies.

/** Codes listed in `lastTurn.unseen` whatever the round: calls that never ran. */
const alwaysUnseen = (code: ErrorCode): boolean => code === "TURN_OVER" || code === "CALLS_CAP";

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
  s.turnFailures.push({
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
  seatOf(gw, line.seat).turnFailures.push({
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
 * A `turn` line: the pending self-wake becomes `selfAt`, the scheduler ends the turn at `t`, and
 * `lastTurn` records how it ended, the failures the agent never saw (those of round `rounds - 1`,
 * the last, and every `TURN_OVER` or `CALLS_CAP`) and the effective next wake.
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
  s.wake.selfAt = line.selfAt;
  wake.end(line.seat, line.t);
  const next = line.next === undefined ? asTurnNext(wake.peek(line.seat)) : line.next;
  const last = line.rounds - 1;
  s.lastTurn = {
    ended: line.why,
    unseen: s.turnFailures
      .filter((f) => f.round >= last || alwaysUnseen(f.code))
      .map(({ tool, code, message }) => ({ tool, code, message })),
    nextWake: next === null ? null : { at: next.at, kind: next.kind },
  };
  s.turnFailures = [];
  return { selfAt: s.wake.selfAt, next: next === null ? null : { at: next.at, kind: next.kind } };
}
