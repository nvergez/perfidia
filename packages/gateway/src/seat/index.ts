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
export { createWakeScheduler, wakeClassOf, wakeReasonOf } from "./wake.ts";
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
  summarizeEvent,
  type ArchiveSearch,
} from "./archive.ts";
export { closeTurn, recordAct, recordGw } from "./turn.ts";
