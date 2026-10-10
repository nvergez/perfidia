import type { GameTime, ToolResult } from "@perfidia/protocol";
import { seatError } from "./errors.ts";
import type { SeatState } from "./types.ts";

// The seat's notebook (§8.4): `write_note` live, and the `note` lines in the rebuild.

/** The notebook after appending `text`: on a new line, or `text` alone when the notebook is empty. */
export function appendedNotes(notes: string, text: string): string {
  if (text === "") return notes;
  return notes === "" ? text : `${notes}\n${text}`;
}

/**
 * Writes the notebook, or rejects with `NOTE_TOO_LONG` and the numbers when the result would
 * exceed `max` characters (UTF-16 code units). A rejection leaves the notes unchanged.
 *
 * `t`, the time of the call, is an addition to §8.4's `writeNote(s, text, mode, max)`: every
 * `ToolResult` carries it (§7.3). The rebuild passes the `note` line's `t`.
 */
export function writeNote(
  s: SeatState,
  text: string,
  mode: "append" | "replace",
  max: number,
  t: GameTime,
): ToolResult {
  const next = mode === "replace" ? text : appendedNotes(s.notes, text);
  if (next.length > max) {
    const details = {
      chars: next.length,
      max,
      over: next.length - max,
      notes: s.notes.length,
      mode,
    };
    return seatError("NOTE_TOO_LONG", details, t);
  }
  s.notes = next;
  return { ok: true, t, data: { chars: next.length, max } };
}
