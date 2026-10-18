import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { THOUGHT_MAX, thoughtOf } from "./thought.ts";

/** C0, DEL, C1 and the line and paragraph separators. */
function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 32 || (c >= 127 && c < 160) || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}

describe("thoughtOf", () => {
  test("joins text blocks, strips control characters and line breaks, collapses spaces", () => {
    expect(thoughtOf(["  Hold c12.\n", "Then\tstrike\u2028p4.\u0000 "])).toBe(
      "Hold c12. Then strike p4.",
    );
    expect(thoughtOf([])).toBeUndefined();
    expect(thoughtOf([" \n\t", ""])).toBeUndefined();
  });

  test("cuts at 400 characters with an ellipsis, never inside a surrogate pair", () => {
    const long = thoughtOf(["x".repeat(1000)]);
    expect(long).toHaveLength(THOUGHT_MAX);
    expect(long?.endsWith("…")).toBe(true);
    const emoji = thoughtOf(["a" + "😀".repeat(300)]) ?? "";
    expect(emoji.length).toBeLessThanOrEqual(THOUGHT_MAX);
    expect(emoji.isWellFormed()).toBe(true);
  });

  test("property: no control character, at most 400 characters, idempotent", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ unit: "binary", maxLength: 600 }), { maxLength: 4 }),
        (texts) => {
          const t = thoughtOf(texts);
          if (t === undefined) return;
          expect(hasControl(t)).toBe(false);
          expect(t.length).toBeLessThanOrEqual(THOUGHT_MAX);
          expect(t).toBe(t.trim());
          expect(thoughtOf([t])).toBe(t);
        },
      ),
    );
  });
});
