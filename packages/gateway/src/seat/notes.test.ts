import { describe, expect, test } from "bun:test";
import { TOOL_RESULT_DATA, ToolResultSchema } from "@perfidia/protocol";
import { appendedNotes, writeNote } from "./notes.ts";
import { createGatewayState, seatOf } from "./state.ts";
import { P1 } from "./testkit.test.ts";
import { groupDigits } from "./text.ts";

const MAX = 4000;

function notebook(notes = "") {
  const s = seatOf(createGatewayState([P1]), P1);
  s.notes = notes;
  return s;
}

describe("writeNote", () => {
  test("append adds a line, replace rewrites; the result gives the size and the limit", () => {
    const s = notebook();
    const first = writeNote(s, "plan: wall to 5", "append", MAX, 100);
    expect(first).toEqual({ ok: true, t: 100, data: { chars: 15, max: MAX } });
    expect(ToolResultSchema.parse(first)).toEqual(first);
    expect(first.ok && TOOL_RESULT_DATA.write_note.parse(first.data)).toEqual({
      chars: 15,
      max: MAX,
    });
    writeNote(s, "p2 is hostile", "append", MAX, 101);
    expect(s.notes).toBe("plan: wall to 5\np2 is hostile");
    expect(writeNote(s, "fresh", "replace", MAX, 102)).toMatchObject({
      ok: true,
      data: { chars: 5 },
    });
    expect(s.notes).toBe("fresh");
    writeNote(s, "", "append", MAX, 103);
    expect(s.notes).toBe("fresh");
    writeNote(s, "", "replace", MAX, 104);
    expect(s.notes).toBe("");
  });

  test("over the limit, an append fails with the numbers and leaves the notes unchanged", () => {
    const s = notebook("a".repeat(3999));
    const err = writeNote(s, "b".repeat(340), "append", MAX, 223320);
    expect(err).toEqual({
      ok: false,
      t: 223320,
      code: "NOTE_TOO_LONG",
      message: "note would be 4,340 chars, limit 4,000: remove 340 or use mode=replace",
      hint: "The notebook holds 3,999 chars. Shorten this text by 340 chars, or rewrite the whole notebook with mode=replace.",
      details: { chars: 4340, max: 4000, over: 340, notes: 3999, mode: "append" },
    });
    expect(ToolResultSchema.parse(err)).toEqual(err);
    expect(s.notes).toBe("a".repeat(3999));
  });

  test("over the limit, a replace fails with the numbers", () => {
    const s = notebook("keep");
    expect(writeNote(s, "x".repeat(4001), "replace", MAX, 0)).toMatchObject({
      ok: false,
      code: "NOTE_TOO_LONG",
      message: "note would be 4,001 chars, limit 4,000: remove 1",
      hint: "Shorten the text by 1 chars: the notebook holds at most 4,000.",
      details: { chars: 4001, over: 1, mode: "replace" },
    });
    expect(s.notes).toBe("keep");
    expect(writeNote(s, "x".repeat(4000), "replace", MAX, 0).ok).toBe(true);
  });

  test("appendedNotes and groupDigits", () => {
    expect(appendedNotes("", "a")).toBe("a");
    expect(appendedNotes("a", "b")).toBe("a\nb");
    expect(appendedNotes("a", "")).toBe("a");
    expect([0, 7, 999, 1000, 4340, 123456, 1234567, -4000].map(groupDigits)).toEqual([
      "0",
      "7",
      "999",
      "1,000",
      "4,340",
      "123,456",
      "1,234,567",
      "-4,000",
    ]);
  });
});
