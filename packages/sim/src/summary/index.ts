// Match summaries (docs/architecture.md §12.2): the pure fold over log lines, its text form and the
// `summary` command.

export {
  LogShapeError,
  SUMMARY_FORMAT,
  controllerText,
  strategyOf,
  summarize,
  wakeClass,
  type ControllerSpan,
  type Distribution,
  type EventCounts,
  type MatchSummary,
  type SeatSummary,
  type SummaryOptions,
  type WakeClass,
  type WakeDay,
} from "./summarize.ts";
export { clockText, formatSummary, table } from "./format.ts";
export { SUMMARY_USAGE, summaryCommand } from "./command.ts";
