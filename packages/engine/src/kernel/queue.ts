import { insertSorted, removeWhere } from "@perfidia/engine/core";
import type { CompiledRules, DeepReadonly, GameState, ScheduledEvent } from "@perfidia/protocol";
import { EngineBug } from "./errors.ts";

// The scheduled-event queue (docs/architecture.md §5.1): `state.queue`, an array kept sorted by
// `(at, cls, seq)`. `seq` is global and unique, so the order never depends on insertion history.

/** The total order of the queue: `(at, cls, seq)`. */
export function compareScheduled(a: ScheduledEvent, b: ScheduledEvent): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  if (a.cls !== b.cls) return a.cls < b.cls ? -1 : 1;
  if (a.seq !== b.seq) return a.seq < b.seq ? -1 : 1;
  return 0;
}

/**
 * Schedules `kind` at `at` (strictly after `now`) with a fresh global seq and returns the seq. The
 * class comes from `rules.eventClasses`; a kind without a class, a non-integer time or a time not
 * after `now` is an `EngineBug` (every duration is ≥ 1 s, §3.6).
 */
export function scheduleEvent(
  state: GameState,
  rules: DeepReadonly<CompiledRules>,
  kind: string,
  at: number,
  ref: string,
): number {
  const cls = rules.eventClasses[kind];
  if (cls === undefined) {
    throw new EngineBug("engine", `schedule("${kind}"): the kind has no class in eventClasses`, {
      kind,
    });
  }
  if (!Number.isSafeInteger(at) || at <= state.now) {
    throw new EngineBug(
      "engine",
      `schedule("${kind}", ${at}, "${ref}") at now = ${state.now}: events are scheduled strictly after now`,
      { kind, at, ref, now: state.now },
    );
  }
  state.seq += 1;
  const seq = state.seq;
  insertSorted(state.queue, { at, cls, seq, kind, ref }, compareScheduled);
  return seq;
}

/** Removes the pending event with this seq; an `EngineBug` if there is none. */
export function cancelEvent(state: GameState, seq: number): ScheduledEvent {
  const removed = removeWhere(state.queue, (e) => e.seq === seq);
  const [event] = removed;
  if (event === undefined || removed.length !== 1) {
    throw new EngineBug("engine", `cancel(${seq}): no pending event has this seq`, { seq });
  }
  return event;
}
