// @perfidia/spectator/reduce: steps applied to frames and game time for display (phase-3 design
// §2.1). Imports `@perfidia/protocol/spectator` only: the web's part of the spectator package.

export { notebookTexts, seatTally, type SeatTally } from "./dossier.ts";
export { applyPatch, applyStep, applySteps, standingsOf } from "./reduce.ts";
export { fmtGameDuration, fmtGameTime } from "./time.ts";
