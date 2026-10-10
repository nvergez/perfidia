// @perfidia/gateway/present: what a seat sees (docs/architecture.md §7.3, §8.1, §8.2, §8.6): the
// fog-of-war views, the briefing, the wording of errors and warnings, and the `rules` payload.
// Pure functions of `(match.read(), seat, gateway state)`: they use `std` derivations, the
// ruleset's visibility hooks with `std.defaultVisibility` as the fallback and `core`'s formatter,
// build fresh objects, and never write to the engine or the gateway state.
//
// Additions to §7.3 and §8.1–8.2, to be adopted there and by T14 (each is also noted where it is
// defined and pinned by a test):
// - A view of a missing city, island or player, and `viewMap` with a missing `fromCity`, is `null`;
//   the tool layer answers `UNKNOWN_ID`.
// - A full city view also lists `outgoing`: the movements leaving the city that the seat can see.
//   The seat's own movements are always shown in full, whatever `movementAccess` says of them.
// - `explain(v, {r, seat, gw})` takes the read context and the gateway state, since `QUEUE_ITEM`
//   reads the seat's archive and the queue, and the other explanations fill numbers the details
//   leave out from the seat's own cities; `toolError` and `toolWarning` wrap it. The detail keys
//   each code reads are those of `explain.test.ts`; T10 and T14 should emit them.
// - The briefing measures its size as compact JSON without `notes`. When not even the newest
//   message fits with its body cut at 300 characters, it is kept with a shorter body (down to
//   `MESSAGE_MIN_CUT`, `cut: true`) instead of leaving every message out. Its `incoming` lists the
//   visible movements of others whose foe or party is the seat or that head to one of its cities,
//   and the attacks (homecomings included) heading to a city it sees in full or holds troops in.
//   In `events` and `news`, standard reports keep their standard fields only (the headline);
//   `read_notes {open}` returns them whole.
// - `rules` leaves out the duration tables (§8.1 allows it), and its `interface` block also lists
//   the wake triggers by class from `rules.gateway.wake`.

export {
  byArrival,
  movementView,
  ownMovements,
  seenMovements,
  type MovementAccess,
  type SeenMovement,
} from "./movements.ts";
export {
  copyJson,
  copyObject,
  durationPair,
  timePair,
  visibilityOf,
  type SeatVisibility,
} from "./common.ts";
export { MESSAGE_CUT, isTimeKey, renderData, renderEvent } from "./events.ts";
export { leaderboard, openProposals, viewCity, viewIsland, viewMap, viewPlayer } from "./views.ts";
export { BRIEFING_TARGET_CHARS, MESSAGE_MIN_CUT, briefingSize, buildBriefing } from "./briefing.ts";
export {
  EXPLAINED_CODES,
  explain,
  toolError,
  toolWarning,
  type ExplainEnv,
  type Explanation,
} from "./explain.ts";
export { agentRules, gatewayRulesCopy, interfaceText, rulesInfo } from "./rules.ts";
