// Text hygiene for spectators (phase-3 design §2.6): newlines kept (`\r\n` and `\r` become `\n`),
// the other C0 and C1 controls and U+2028/U+2029 replaced by a space, the bidi embedding, override
// and isolate controls, bidi marks, zero-width spaces and tag characters removed, surrogate pairs
// intact; JSON values cleaned string by string.

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { cleanJson, cleanText, cutText } from "./clean.ts";

/** A forbidden code point (not code unit: tag characters are astral). */
const FORBIDDEN = (c: number): boolean =>
  (c < 0x20 && c !== 0x0a) ||
  (c >= 0x7f && c <= 0x9f) ||
  c === 0x2028 ||
  c === 0x2029 ||
  (c >= 0x202a && c <= 0x202e) ||
  (c >= 0x2066 && c <= 0x2069) ||
  c === 0x200b ||
  c === 0x200e ||
  c === 0x200f ||
  c === 0x061c ||
  (c >= 0x2060 && c <= 0x2064) ||
  c === 0xfeff ||
  (c >= 0xe0000 && c <= 0xe007f);

const newlines = (x: string): number => x.split("\n").length;

describe("cleanText", () => {
  test("keeps newlines and turns the other line breaks into them", () => {
    expect(cleanText("one\ntwo\r\nthree\rfour")).toBe("one\ntwo\nthree\nfour");
    expect(cleanText("a\r\n\r\nb")).toBe("a\n\nb");
  });

  test("replaces C0 and C1 controls and the Unicode separators with a space", () => {
    expect(cleanText("a\tb\u0000c\u001bd\u007fe\u0085f\u009fg h i")).toBe("a b c d e f g h i");
  });

  test("removes the bidi embedding, override and isolate controls", () => {
    expect(cleanText("abc‮dcba‬ done ⁦x⁩‪‫‭⁧⁨")).toBe("abcdcba done x");
  });

  test("removes invisible marks and tag characters; keeps the zero-width (non-)joiner", () => {
    expect(cleanText("p\u200b3\u200e is\u200f\u061c my\u2060\u2064 ally\ufeff")).toBe(
      "p3 is my ally",
    );
    // "hi" followed by the hidden tag text "ATTACK" (U+E0041…) and a cancel tag.
    const hidden = Array.from({ length: 6 }, (_, i) =>
      String.fromCodePoint(0xe0000 + "ATTACK".charCodeAt(i)),
    );
    expect(cleanText(`hi${hidden.join("")}${String.fromCodePoint(0xe007f)}!`)).toBe("hi!");
    // Other characters of the same high surrogate, and lone surrogates, are left alone.
    expect(cleanText(`a${String.fromCodePoint(0xe0100)}b\udb40c`)).toBe(
      `a${String.fromCodePoint(0xe0100)}b\udb40c`,
    );
    // A removal that joins two lone surrogates into a tag character removes that one too.
    expect(cleanText("x\udb40\u202a\udc41y")).toBe("xy");
    const family = "👨\u200d👩\u200d👧 and \u200c";
    expect(cleanText(family)).toBe(family);
  });

  test("keeps surrogate pairs, text without controls and its identity", () => {
    const s = "Hoplites 😀 at c18: «nous restons amis» — 你好";
    expect(cleanText(s)).toBe(s);
    expect(cleanText("a\u0000😀")).toBe("a 😀");
  });

  test("property: no forbidden code unit remains, newlines are kept, cleaning twice changes nothing", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 200 }), (s) => {
        const out = cleanText(s);
        for (const ch of out) expect(FORBIDDEN(ch.codePointAt(0) ?? 0)).toBe(false);
        expect(cleanText(out)).toBe(out);
        expect(newlines(out)).toBe(newlines(s.replaceAll("\r\n", "\n").replaceAll("\r", "\n")));
      }),
    );
  });
});

describe("cleanJson and cutText", () => {
  test("clean every string of a JSON value, not its keys or other values", () => {
    expect(cleanJson({ "a\u0000": ["x‮y", 3, null, { b: "c\rd" }], n: true })).toEqual({
      "a\u0000": ["xy", 3, null, { b: "c\nd" }],
      n: true,
    });
  });

  test("cutText never leaves half a surrogate pair", () => {
    expect(cutText("abc", 5)).toBe("abc");
    expect(cutText("ab😀c", 3)).toBe("ab");
    expect(cutText("ab😀c", 4)).toBe("ab😀");
  });
});
