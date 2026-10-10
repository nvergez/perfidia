import type { ReadCtx } from "@perfidia/engine/contracts";
import { isHeldAgainst, sortedIds } from "@perfidia/engine/std";
import {
  compareIds,
  type DeepReadonly,
  type Movement,
  type MovementView,
  type PlayerId,
} from "@perfidia/protocol";
import { orderedUnits, resCopy, timePair, type SeatVisibility } from "./common.ts";

// Movements as a seat may see them (docs/architecture.md §8.1): `own` and `full` in full,
// `incoming` without composition (origin city and owner, recorded foe, launch and arrival times,
// "turned back at t"). Launch and arrival together reveal the pace; rulesets say so in their
// cheat sheets.

export type MovementAccess = "own" | "full" | "incoming";

/** A movement the seat can see, with the access its ruleset grants. */
export interface SeenMovement {
  readonly m: DeepReadonly<Movement>;
  readonly access: MovementAccess;
}

/** Every movement `viewer` can see, in `compareIds` order of the ids (§6.5). */
export function seenMovements(r: ReadCtx, vis: SeatVisibility, viewer: PlayerId): SeenMovement[] {
  const out: SeenMovement[] = [];
  for (const id of sortedIds(r.state.movements)) {
    const m = r.state.movements[id];
    if (m === undefined) continue;
    const access = vis.movementAccess(viewer, id);
    if (access !== null) out.push({ m, access });
  }
  return out;
}

/**
 * The seat's own movements, which it always sees in full (perfidia-1 §12), whatever the ruleset's
 * `movementAccess` says of them; in `compareIds` order of the ids.
 */
export function ownMovements(r: ReadCtx, seat: PlayerId): SeenMovement[] {
  return sortedIds(r.state.movements).flatMap((id) => {
    const m = r.state.movements[id];
    return m === undefined || m.owner !== seat ? [] : [{ m, access: "own" as const }];
  });
}

/** Arrival first, then id: the order in which movements matter. */
export function byArrival(a: SeenMovement, b: SeenMovement): number {
  return a.m.arriveAt - b.m.arriveAt || compareIds(a.m.id, b.m.id);
}

/** The end of the recall window of an own movement, or `null` when it cannot be recalled now. */
function recallableUntil(r: ReadCtx, m: DeepReadonly<Movement>): number | null {
  const recall = r.rules.movement.recall;
  if (m.back !== null || m.kind === "return" || m.kind === "spy" || m.kind === "shipment") {
    return null;
  }
  if (!recall.kinds.includes(m.kind)) return null;
  const until = m.departAt + recall.window;
  return r.now <= until ? until : null;
}

/** A fresh view of `m` at the given access. */
export function movementView(
  r: ReadCtx,
  m: DeepReadonly<Movement>,
  access: MovementAccess,
): MovementView {
  const view: MovementView = {
    id: m.id,
    kind: m.kind,
    access,
    owner: m.owner,
    from: m.from,
    to: m.to,
    party: m.party,
    depart: timePair(m.departAt),
    arrive: timePair(m.arriveAt),
  };
  if (m.back !== null) view.turnedBack = timePair(m.back.at);
  if (m.kind === "return" && isHeldAgainst(r, m.home, m.owner)) view.homecoming = true;
  if (access === "incoming") return view;
  view.home = m.home;
  view.units = orderedUnits(r.rules.units, m.units);
  view.cargo = resCopy(m.cargo);
  if (m.kind === "spy") view.gold = m.gold;
  if (access === "own") {
    const until = recallableUntil(r, m);
    view.recallableUntil = until === null ? null : timePair(until);
  }
  return view;
}
