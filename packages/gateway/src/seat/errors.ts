import { DAY, fmtDuration, fmtTime } from "@perfidia/engine/core";
import type { GameTime, ToolError, ViolationDetails } from "@perfidia/protocol";
import { groupDigits } from "./text.ts";

// The errors the seat logic raises (§7.2 layers 1 and 4): their wording is a pure function of the
// code, the details and the time, which a `gw` line carries. The live host returns these texts,
// and the rebuild (§10.5) regenerates the same `lastTurn` messages from the logged details. §7.3
// puts every domain code's wording in `present/explain.ts`; for these four codes it should
// delegate here, so the agent and the rebuild see one wording.

/** Codes worded here. */
export const SEAT_ERROR_CODES = [
  "DAILY_CAP",
  "CALLS_CAP",
  "ROUND_TRIP_CAP",
  "NOTE_TOO_LONG",
] as const;
export type SeatErrorCode = (typeof SEAT_ERROR_CODES)[number];

const DAILY_WHAT: Readonly<Record<string, string>> = {
  attacks: "attack launches",
  messages: "messages",
};

function int(details: ViolationDetails, key: string): number | null {
  const value = Object.hasOwn(details, key) ? details[key] : undefined;
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function str(details: ViolationDetails, key: string): string | null {
  const value = Object.hasOwn(details, key) ? details[key] : undefined;
  return typeof value === "string" ? value : null;
}

/** `{message, hint}` of a seat error from its details, or `null` for another code or malformed details. */
export function seatErrorText(
  code: string,
  details: ViolationDetails | undefined,
  t: GameTime,
): { message: string; hint: string } | null {
  if (details === undefined) return null;
  switch (code) {
    case "DAILY_CAP": {
      const kind = str(details, "kind");
      const cap = int(details, "cap");
      const used = int(details, "used");
      const at = int(details, "availableAt");
      const what = kind !== null && Object.hasOwn(DAILY_WHAT, kind) ? DAILY_WHAT[kind] : undefined;
      if (what === undefined || cap === null || used === null || at === null || at < t) return null;
      return {
        message: `${used} of ${cap} ${what} already used on D${Math.floor(at / DAY)}: the limit is ${cap} per game day.`,
        hint: `The count restarts at ${fmtTime(at)} (in ${fmtDuration(at - t)}); use this turn for other orders.`,
      };
    }
    case "CALLS_CAP": {
      const scope = str(details, "scope");
      const cap = int(details, "cap");
      const used = int(details, "used");
      if (cap === null || used === null) return null;
      if (scope === "round") {
        return {
          message: `Only the first ${cap} calls of a round trip run; this was call ${used + 1}.`,
          hint: `Send at most ${cap} calls per round trip; send this one again in the next round.`,
        };
      }
      if (scope === "wake") {
        return {
          message: `A wake runs at most ${cap} calls, and ${used} already ran.`,
          hint: "This wake has no calls left: end the turn with end_turn.",
        };
      }
      return null;
    }
    case "ROUND_TRIP_CAP": {
      const cap = int(details, "cap");
      const round = int(details, "round");
      if (cap === null || round === null) return null;
      return {
        message: `A wake has at most ${cap} round trips; this call came in round trip ${round}.`,
        hint: "End the turn with end_turn; the next wake brings a new set of round trips.",
      };
    }
    case "NOTE_TOO_LONG": {
      const chars = int(details, "chars");
      const max = int(details, "max");
      const over = int(details, "over");
      const notes = int(details, "notes");
      const mode = str(details, "mode");
      if (chars === null || max === null || over === null || notes === null) return null;
      if (mode === "append") {
        return {
          message: `note would be ${groupDigits(chars)} chars, limit ${groupDigits(max)}: remove ${groupDigits(over)} or use mode=replace`,
          hint: `The notebook holds ${groupDigits(notes)} chars. Shorten this text by ${groupDigits(over)} chars, or rewrite the whole notebook with mode=replace.`,
        };
      }
      if (mode === "replace") {
        return {
          message: `note would be ${groupDigits(chars)} chars, limit ${groupDigits(max)}: remove ${groupDigits(over)}`,
          hint: `Shorten the text by ${groupDigits(over)} chars: the notebook holds at most ${groupDigits(max)}.`,
        };
      }
      return null;
    }
    default:
      return null;
  }
}

/** The `ToolError` of a seat error, worded from its details. */
export function seatError(code: SeatErrorCode, details: ViolationDetails, t: GameTime): ToolError {
  const text = seatErrorText(code, details, t);
  if (text === null) throw new Error(`seatError: malformed details for ${code}`);
  return { ok: false, t, code, message: text.message, hint: text.hint, details };
}
