import { describe, expect, test } from "bun:test";
import { nextTabIndex } from "./tabs.tsx";

// The tabs' keyboard (docs/phase3.md §16): the arrows wrap, Home and End jump, other keys do nothing.

describe("nextTabIndex", () => {
  test("arrows move and wrap, Home and End jump", () => {
    expect(nextTabIndex(3, 0, "ArrowRight")).toBe(1);
    expect(nextTabIndex(3, 2, "ArrowRight")).toBe(0);
    expect(nextTabIndex(3, 0, "ArrowLeft")).toBe(2);
    expect(nextTabIndex(3, 1, "ArrowLeft")).toBe(0);
    expect(nextTabIndex(4, 2, "Home")).toBe(0);
    expect(nextTabIndex(4, 1, "End")).toBe(3);
  });

  test("other keys and an empty list move nothing", () => {
    expect(nextTabIndex(3, 1, "ArrowDown")).toBeNull();
    expect(nextTabIndex(3, 1, "Enter")).toBeNull();
    expect(nextTabIndex(0, 0, "ArrowRight")).toBeNull();
  });
});
