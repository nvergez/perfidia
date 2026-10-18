// @perfidia/spectator: the spectator projection (phase-3 design §2): `match.jsonl` folded line by
// line through the engine's incremental replay and the gateway's incremental fold into frames,
// steps (patches and feed items), key moments and keyframes, for the read-only server and, through
// the `./reduce` sub-path, the web. Pure: no I/O, no clock, browser-runnable. Side files (costs,
// reasoning) are the separate `./annotations` fold.

export { cleanJson, cleanObject, cleanText, cutText } from "./clean.ts";
export { TIMELINE_VERSION, logIdOf, timelineIdOf } from "./version.ts";
export {
  KEYFRAME_STEPS,
  THOUGHT_MAX_CHARS,
  createSpectatorFold,
  foldLog,
  type Keyframe,
  type SeatCounts,
  type SpectatorFold,
  type SpectatorFoldOptions,
} from "./fold/fold.ts";
export { CONTEXT_ITEMS, CONTEXT_WINDOW, type FeedDraft } from "./fold/feed.ts";
export { citiesOf, momentOf, titleOf } from "./fold/moments.ts";
export { popUsedByCity } from "./fold/project.ts";
export { rulesetEvents, type RulesetEvents } from "./fold/rulesets.ts";
export {
  applyPatch,
  applyStep,
  applySteps,
  fmtGameDuration,
  fmtGameTime,
  standingsOf,
} from "./reduce/index.ts";
export {
  DEFAULT_POLICY,
  createAnnotationFold,
  type AnnotationFold,
  type AnnotationPolicy,
} from "./annotations/index.ts";
