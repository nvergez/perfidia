import { describe, expect, test } from "bun:test";
import { wakeKind, wakeKinds, wakeWords } from "./wake.ts";

// Wake reasons in words and icon kinds (the thoughts column's history).

describe("wake reasons", () => {
  test("known reasons read in words, with their argument", () => {
    expect(wakeWords("queue_empty c24")).toBe("a queue running empty (c24)");
    expect(wakeWords("self")).toBe("its own alarm");
    expect(wakeWords("message p3")).toBe("a message (p3)");
  });

  test("an event type the column does not know reads as words", () => {
    expect(wakeWords("some_event p6")).toBe("some event (p6)");
    expect(wakeKind("some_event p6")).toBe("event");
  });

  test("kinds, distinct and in order", () => {
    expect(wakeKinds(["battle_report r1", "incoming_attack m2", "battle_report r3"])).toEqual([
      "battle",
      "danger",
    ]);
    expect(wakeKind("spy_detected c3")).toBe("spy");
    expect(wakeKind("start")).toBe("start");
  });
});
