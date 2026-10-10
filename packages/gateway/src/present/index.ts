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
//   The seat's own movements are always `own`, in full, in every view and the briefing, whatever
//   `movementAccess` says of them (`seenMovements`).
// - A return's recorded party is history (the target of the attack it was). Every view shows as
//   the party of a return heading into a held home the besieger it will fight (`homecomingFoe`,
//   perfidia-1 §9.3), and under `incoming` access never the return's own party nor `turnedBack`
//   (perfidia-1 §12: id, owner, launch and arrival times). `movementView` takes the viewer.
// - `explain(v, {r, seat, gw})` takes the read context and the gateway state, since `QUEUE_ITEM`
//   reads the seat's archive and the queue, and the other explanations fill numbers the details
//   leave out from the seat's own cities; `toolError` and `toolWarning` wrap it. It reads the
//   detail shapes `std` and the default domain handlers emit (branch p1/T10), pinned case by case
//   in `explain.test.ts`.
// - The briefing measures its size as compact JSON without `notes`. When not even the newest
//   message fits with its body cut at 300 characters, it is kept with a shorter body (down to
//   `MESSAGE_MIN_CUT`, `cut: true`) instead of leaving every message out. Its `incoming` lists the
//   visible movements of others whose foe or party is the seat or that head to one of its cities,
//   the attacks (homecomings included) heading to a city it sees in full or holds troops in, and
//   every attack it was told about that was turned back since its last briefing (`turnedBack`,
//   from the `movement_recalled` notice: perfidia-1 §7.4's "turned back at t"), whose notices then
//   leave `events`. Every `events` and `news` entry carries `at`, the event's time as a pair; standard
//   reports keep their standard fields only (the headline), and `read_notes {open}` returns them
//   whole. `more.events` names a `read_notes` search of the event types left out; the `more`
//   searches also return the entries kept (and, for `msgs`, the seat's own messages), so they can
//   list more than `count`.
// - `rules` leaves out the duration tables (§8.1 allows it), and its `interface` block also lists
//   the wake triggers by class from `rules.gateway.wake`.
//
// Budgets not met, with measurements (§8.1 asks to report them; the tests pin the sizes):
// - `rules` for perfidia-1 at N = 12: 17,762 characters against 12,000: the effective config 4,277,
//   the agent rules 7,801 (cost tables required by `AgentRulesSchema`), the cheat sheet 2,203 and the
//   interface block 3,166. Meeting 12,000 needs §8.1 to drop or shorten a part (e.g. the config,
//   which the agent rules repeat in compiled form).
// - `view_map` with `fromCity` for perfidia-1 at N = 12: at most 8,325 at the start (12 capitals and
//   the Crown) but 10,531 to 10,579 in a mid-game world of 37 cities (three a player) with city
//   points and three sieges: each city row costs about 70 characters, and `CityRowSchema`,
//   `MapIslandSchema` and the `travel` pairs leave nothing to drop.
// - The briefing's 2,400 target for a 3-city perfidia-1 seat (with its city points, sieges and
//   countdowns): met with one incoming attack, but 2,457 with three, even after every list that can
//   give way has, and 3,523 with full queues in every city (5 build items and 2 recruit batches
//   each), since cities, `incoming` and `proposals` never give way and `BriefingCitySchema` requires
//   `build` and `recruit` even when empty. Non-attack incoming movements do not give way either: no
//   single call lists them across cities (`view_city` is per city).
// - A return keeps `from`: after a bounce it is the city the attack was aimed at, which the
//   besieger of its home then sees (`MovementViewSchema` and `BriefingIncomingSchema` require it,
//   and perfidia-1's homecoming notice carries it too).

export {
  byArrival,
  homecomingFoe,
  movementView,
  ownMovements,
  partyOf,
  seenMovements,
  type MovementAccess,
  type SeenMovement,
} from "./movements.ts";
export {
  copyJson,
  copyObject,
  cutText,
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
