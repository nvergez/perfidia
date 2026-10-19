import { describe, expect, test } from "bun:test";
import { focusKind, keyCommand, type FocusTarget, type KeyLike } from "./keys.ts";

const key = (k: string, o: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...o,
});

function el(
  tagName: string,
  attrs: Readonly<Record<string, string>> = {},
  inside: readonly string[] = [],
): FocusTarget {
  return {
    tagName,
    getAttribute: (n) => attrs[n] ?? null,
    closest: (sel) => (inside.some((s) => sel.includes(s)) ? {} : null),
  };
}

describe("playback shortcuts", () => {
  test("space, arrows and plus/minus on the page", () => {
    expect(keyCommand(key(" "), "none")).toBe("toggle");
    expect(keyCommand(key("ArrowLeft"), "none")).toBe("prev");
    expect(keyCommand(key("ArrowRight"), "none")).toBe("next");
    expect(keyCommand(key("+"), "none")).toBe("faster");
    expect(keyCommand(key("="), "none")).toBe("faster");
    expect(keyCommand(key("-"), "none")).toBe("slower");
    expect(keyCommand(key("x"), "none")).toBeNull();
  });

  test("left alone: modifiers, typing, dialogs, and controls that use the key", () => {
    expect(keyCommand(key("ArrowRight", { metaKey: true }), "none")).toBeNull();
    expect(keyCommand(key("+", { ctrlKey: true }), "none")).toBeNull();
    expect(keyCommand(key(" "), "text")).toBeNull();
    expect(keyCommand(key("-"), "text")).toBeNull();
    expect(keyCommand(key(" "), "dialog")).toBeNull();
    expect(keyCommand(key(" "), "control")).toBeNull();
    expect(keyCommand(key("ArrowLeft"), "control")).toBe("prev");
    expect(keyCommand(key("ArrowLeft"), "arrows")).toBeNull();
    expect(keyCommand(key("+"), "arrows")).toBe("faster");
  });

  test("on the timeline's slider: Space plays or pauses, the arrows stay the slider's", () => {
    expect(keyCommand(key(" "), "slider")).toBe("toggle");
    expect(keyCommand(key("ArrowLeft"), "slider")).toBeNull();
    expect(keyCommand(key("ArrowRight"), "slider")).toBeNull();
    expect(keyCommand(key("-"), "slider")).toBe("slower");
  });

  test("what has the focus", () => {
    expect(focusKind(null)).toBe("none");
    expect(focusKind(el("BODY"))).toBe("none");
    expect(focusKind(el("INPUT"))).toBe("text");
    expect(focusKind(el("INPUT", { type: "range" }))).toBe("slider");
    expect(focusKind(el("INPUT", { type: "checkbox" }))).toBe("control");
    expect(focusKind(el("SELECT"))).toBe("text");
    expect(focusKind(el("BUTTON"))).toBe("control");
    expect(focusKind(el("DIV", { role: "slider" }))).toBe("slider");
    expect(focusKind(el("BUTTON", { role: "tab" }))).toBe("arrows");
    expect(focusKind(el("g", { role: "button" }))).toBe("control");
    expect(focusKind(el("BUTTON", {}, ['[role="dialog"]']))).toBe("dialog");
    expect(focusKind(el("BUTTON", {}, ["dialog,"]))).toBe("dialog");
    expect(focusKind(el("BUTTON", {}, ['[role="radiogroup"]']))).toBe("control");
    expect(focusKind(el("SPAN", {}, ['[role="tablist"]']))).toBe("arrows");
    expect(focusKind({ ...el("DIV"), isContentEditable: true })).toBe("text");
  });
});
