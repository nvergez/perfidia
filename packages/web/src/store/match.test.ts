import { describe, expect, test } from "bun:test";
import { addLiveAnnot, LIVE_TURNS_KEPT, turnKey, type AnnotMsg } from "./match.ts";

// The live rounds kept for Pass C's live reasoning (docs/phase3.md §16.4): a resent round replaces
// the one held, and each seat keeps its newest turns only.

const annot = (seat: "p1" | "p2", turn: number, round: number, text = ""): AnnotMsg => ({
  type: "annot",
  match: "m",
  seat,
  turn,
  round,
  kind: "round",
  reasoning: [text],
  text: [],
  calls: [],
  complete: false,
});

describe("addLiveAnnot", () => {
  test("appends rounds in arrival order; a resent round replaces the one held", () => {
    let s = addLiveAnnot({}, annot("p1", 3, 0, "a"));
    s = addLiveAnnot(s, annot("p1", 3, 1, "b"));
    s = addLiveAnnot(s, annot("p1", 3, 0, "a2"));
    s = addLiveAnnot(s, { ...annot("p1", 3, 0, "t"), kind: "thought_call" });
    expect(s[turnKey("p1", 3)]?.map((m) => `${m.kind}:${m.round}:${m.reasoning[0]}`)).toEqual([
      "round:0:a2",
      "round:1:b",
      "thought_call:0:t",
    ]);
  });

  test("keeps the newest turns of each seat, other seats untouched; inputs unchanged", () => {
    let s = addLiveAnnot({}, annot("p2", 1, 0));
    for (let turn = 1; turn <= 5; turn += 1) s = addLiveAnnot(s, annot("p1", turn, 0));
    expect(LIVE_TURNS_KEPT).toBe(2);
    expect(Object.keys(s).toSorted((a, b) => (a < b ? -1 : 1))).toEqual(["p1:4", "p1:5", "p2:1"]);
    const before = structuredClone(s);
    addLiveAnnot(s, annot("p1", 6, 0));
    expect(s).toEqual(before);
  });
});
