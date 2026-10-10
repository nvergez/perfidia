import type { ReadCtx } from "@perfidia/engine/contracts";
import { sortedIds } from "@perfidia/engine/std";
import {
  compareIds,
  type DeepReadonly,
  type Movement,
  type MovementView,
  type PlayerId,
} from "@perfidia/protocol";
import { lookup, orderedUnits, resCopy, timePair, type SeatVisibility } from "./common.ts";

// Movements as a seat may see them (docs/architecture.md §8.1): `own` and `full` in full,
// `incoming` without composition (origin city and owner, recorded foe, launch and arrival times).
// Launch and arrival together reveal the pace; rulesets say so in their cheat sheets.
//
// A return is the one movement whose recorded party is history: after a recall or a bounce it still
// names the target of the movement it was, which the besieger of its home (the only other player
// shown a return by default, perfidia-1 §12) was never told about. Under `incoming` access a return
// therefore shows as its party the besieger it will fight (the homecoming battle's foe, perfidia-1
// §9.3), or `null`, and no `turnedBack`: perfidia-1 §12 gives the besieger its id, owner, launch
// and arrival times.

export type MovementAccess = "own" | "full" | "incoming";

/** A movement the seat can see, with the access its ruleset grants. */
export interface SeenMovement {
  readonly m: DeepReadonly<Movement>;
  readonly access: MovementAccess;
}

/**
 * Every movement `viewer` can see, in `compareIds` order of the ids (§6.5). The viewer's own
 * movements are always `own` (perfidia-1 §12), whatever the ruleset's `movementAccess` says of
 * them; the others have the access it grants.
 */
export function seenMovements(r: ReadCtx, vis: SeatVisibility, viewer: PlayerId): SeenMovement[] {
  const out: SeenMovement[] = [];
  for (const id of sortedIds(r.state.movements)) {
    const m = r.state.movements[id];
    if (m === undefined) continue;
    const access = m.owner === viewer ? "own" : vis.movementAccess(viewer, id);
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

/**
 * The besieger a return heading into a held home will fight (§5.4; perfidia-1 §9.3): the owner of
 * a `hold` group stationed in the home, other than the mover; `viewer` when it is one of several
 * such owners, else the first of them in `compareIds` order. `null` for anything but such a return.
 */
export function homecomingFoe(
  r: ReadCtx,
  m: DeepReadonly<Movement>,
  viewer: PlayerId,
): PlayerId | null {
  if (m.kind !== "return") return null;
  const holders = (lookup(r.state.cities, m.home)?.stationed ?? [])
    .filter((g) => g.role === "hold" && g.owner !== m.owner)
    .map((g) => g.owner);
  if (holders.includes(viewer)) return viewer;
  return holders.toSorted(compareIds)[0] ?? null;
}

/**
 * The recorded foe or party of `m` as `viewer` sees it at `access`: `m.party`, except for a return,
 * whose foe is the besieger of its home when it heads into a held one, and whose own party (the
 * target of the movement it was) only its owner and `full` viewers see.
 */
export function partyOf(
  r: ReadCtx,
  m: DeepReadonly<Movement>,
  access: MovementAccess,
  viewer: PlayerId,
): PlayerId | null {
  if (m.kind !== "return") return m.party;
  return homecomingFoe(r, m, viewer) ?? (access === "incoming" ? null : m.party);
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

/** A fresh view of `m` for `viewer` at the given access. */
export function movementView(
  r: ReadCtx,
  m: DeepReadonly<Movement>,
  access: MovementAccess,
  viewer: PlayerId,
): MovementView {
  const view: MovementView = {
    id: m.id,
    kind: m.kind,
    access,
    owner: m.owner,
    from: m.from,
    to: m.to,
    party: partyOf(r, m, access, viewer),
    depart: timePair(m.departAt),
    arrive: timePair(m.arriveAt),
  };
  if (homecomingFoe(r, m, viewer) !== null) view.homecoming = true;
  if (access === "incoming") return view;
  if (m.back !== null) view.turnedBack = timePair(m.back.at);
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
