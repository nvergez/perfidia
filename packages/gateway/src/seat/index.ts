// @perfidia/gateway/seat: seat state, wake scheduler, caps, notes, archive and public feed
// (docs/architecture.md §8.4–8.6). Pure functions over protocol types and `GatewayRules`; the whole
// state is JSON. Each function takes the data of one log line (§10.2), so the live host and
// `rebuildGatewayState` (§10.5) drive the state through the same calls:
//
//   ev    → deliver
//   wake  → wake.begin, then briefed (the host builds the briefing in between)
//   act   → recordAct
//   gw    → recordGw
//   note  → writeNote
//   turn  → closeTurn (wake.end, selfAt, lastTurn)
//   defer → wake.defer
//
// `wake.requestSelfWake` serves the live `end_turn` call; the `turn` line's `selfAt` carries its
// result to the rebuild.
//
// Deviations from §8.2, §8.4, §8.5 and §10.5, to be adopted there and by T13, T14 and T16 (each is
// also noted where it is defined, and pinned by a test):
// - `requestSelfWake(seat, at, now)`: `now`, the `end_turn` call time, is the base of the clamp
//   range of §8.3. The scheduler has no clock, and in a real-time turn neither `lastEnd` nor the
//   wake time is the call time.
// - `writeNote(s, text, mode, max, t)`: `t` because every `ToolResult` carries it (§7.3).
// - The wake fold is `wake.begin`, then `briefed(gw, seat, t)`, which empties the inbox and moves
//   the news cursor; §10.5 names `begin` alone.
// - The turn, act and gw folds are the functions `closeTurn` (`wake.end`, then `selfAt` and
//   `lastTurn`), `recordAct` and `recordGw`; §10.5 names `end`, "daily counters" and "failures".
// - `searchArchive` returns `ArchiveHit[]` as §8.4 says; `searchArchivePage` adds the `more` flag
//   of the `read_notes` result.
// - `WakeScheduler` adds `rules` (read by `deliver` for `publicOncePerDay`) and `peek(seat)` (the
//   effective next wake, for the `turn` line's `next` and `lastTurn.nextWake`).
// - State fields beyond §8.4 and §8.5: `SeatWake.urgentReasons` and `SeatWake.deferTo`,
//   `SeatState.lastBriefingE` and `SeatState.turnFailures`.
// - A seat's news (`unreadNews`) is the feed after the delivery number `lastBriefingE`, not after
//   the time `lastBriefingAt` (a time cannot split the events of one second), and leaves out the
//   events addressed to the seat, which its inbox already holds.
// - `lastTurn.unseen` folds repeated `TURN_OVER` and `CALLS_CAP` rejections into one entry per
//   code with a `count` field (§8.2 lists each call and has no `count`), so it stays bounded
//   however many calls an agent sends.
// - `wake.begin` drains an urgent reason only once its `urgentMinGap` has passed: an urgent trigger
//   inside the gap stays pending through an earlier non-urgent wake and fires at the end of the gap
//   (§8.5 says `begin` drains every pending reason). This keeps the P11 urgent-timing bullet and
//   the per-day urgent bound.
// - `deliver` also calls `wake.eliminate` on `player_eliminated`, so the `ev` line drives the
//   elimination in the live host and in the rebuild alike.
// - `seatErrorText` words `DAILY_CAP`, `CALLS_CAP`, `ROUND_TRIP_CAP` and `NOTE_TOO_LONG` from the
//   details a `gw` line keeps, so the rebuild regenerates the `lastTurn` messages; §7.3 puts all
//   wording in `present/explain.ts`, which should delegate to it for these codes.
// - `ArchiveHit.e` and `ArchiveEntry.e` (`read_notes`) number only the entries the seat can read
//   (its archive and the public feed, in delivery order from 1), not the gateway's delivery number
//   of §8.4: that one counts every delivered event, other seats' private events included, so a seat
//   could count hidden activity between two of its entries (P15, found by T16). Search order is
//   unchanged, newest first by `(t, delivery number)`. Pinned in `archive.test.ts`.
// - §10.5 says a regenerated `gw` message is "the bare code when the explainer throws, as in the
//   live host"; the live host words an `INTERNAL` whose explainer throws with the fixed
//   `INTERNAL_FALLBACK` text (`runtime/tools.ts`), so `rebuildGatewayState` does the same for
//   `INTERNAL` and keeps the bare code for the other codes (a batch item's rejection).

export type {
  ArchiveQuery,
  DayCounters,
  Delivered,
  GatewayState,
  LastTurn,
  NextWake,
  NextWakeKind,
  SeatState,
  SeatWake,
  TurnFailure,
  UnseenFailure,
  WakeRecord,
  WakeScheduler,
} from "./types.ts";
export {
  addressedTo,
  briefed,
  createGatewayState,
  dayOf,
  initialSeatWake,
  isSeat,
  rollDay,
  seatOf,
  sortedSeats,
  todayCounters,
  unreadNews,
} from "./state.ts";
export { createWakeScheduler, isPublicMessage, wakeClassOf, wakeReasonOf } from "./wake.ts";
export { deliver } from "./deliver.ts";
export { appendedNotes, writeNote } from "./notes.ts";
export { SEAT_ERROR_CODES, seatError, seatErrorText, type SeatErrorCode } from "./errors.ts";
export {
  checkCallCap,
  checkDailyCap,
  checkRoundTrip,
  dailyCap,
  dailyUsed,
  roundCallCap,
  seatBudget,
  type DailyCapKind,
  type SeatBudget,
} from "./caps.ts";
export {
  entryId,
  involves,
  openArchive,
  searchArchive,
  searchArchivePage,
  summarizeEvent,
  type ArchiveSearch,
} from "./archive.ts";
export { closeTurn, recordAct, recordGw } from "./turn.ts";
