// Bot memory in the notebook (docs/architecture.md §11.1): compact JSON within the cap; anything it
// cannot parse is empty memory.

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { emptyMemory, encodeMemory, parseMemory, type Memory } from "./memory.ts";

const full: Memory = {
  s: "opportunist",
  h: "0123456789abcdef:6",
  f: { i12: 50000, i3: 40000 },
  m: ["ally p2 since D1", "pact p4 since D2"],
  x: { pr: 1, tr: 1, bt: 4 },
  k: ["tm0k4qz", "q0000a"],
};

describe("memory", () => {
  test("round-trips through its compact JSON, keys in a fixed order", () => {
    const text = encodeMemory(full, 4000);
    expect(parseMemory(text, "opportunist")).toEqual(full);
    expect(text).toBe(
      '{"v":1,"s":"opportunist","h":"0123456789abcdef:6","f":{"i3":40000,"i12":50000},' +
        '"m":["ally p2 since D1","pact p4 since D2"],"x":{"bt":4,"pr":1,"tr":1},"k":["tm0k4qz","q0000a"]}',
    );
    // Insertion order does not matter.
    const shuffled: Memory = { ...full, f: { i3: 40000, i12: 50000 }, x: { tr: 1, bt: 4, pr: 1 } };
    expect(encodeMemory(shuffled, 4000)).toBe(text);
  });

  test("a notebook it cannot read is empty memory", () => {
    const notes = [
      "",
      "Plan: attack p3 at dawn.",
      "{",
      "null",
      "[1,2]",
      '{"v":2,"s":"opportunist","h":null,"f":{},"m":[],"x":{},"k":[]}',
      '{"v":1,"s":"opportunist","h":null,"f":{"x9":1},"m":[],"x":{},"k":[]}',
      '{"v":1,"s":"opportunist","h":null,"f":{},"m":[],"x":{"BT":1},"k":[]}',
      '{"v":1,"s":"opportunist","h":null,"f":{},"m":[],"x":{},"k":[],"extra":1}',
      '{"v":1,"s":"opportunist","h":null,"f":{"__proto__":{"polluted":1}},"m":[],"x":{},"k":[]}',
      "x".repeat(4000),
    ];
    for (const n of notes)
      expect(parseMemory(n, "opportunist")).toEqual(emptyMemory("opportunist"));
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });

  test("another strategy's memory is not this one's", () => {
    const text = encodeMemory(full, 4000);
    expect(parseMemory(text, "rusher")).toEqual(emptyMemory("rusher"));
  });

  test("trims handled ids, then memo lines, then foundings, then flags, then the key", () => {
    const text = encodeMemory(full, 4000);
    const fits = (n: number): Memory => parseMemory(encodeMemory(full, n), "opportunist");
    expect(fits(text.length - 1).k).toEqual(["q0000a"]);
    const bare = encodeMemory({ ...full, f: {}, m: [], x: {}, k: [] }, 4000);
    const noFlags = fits(bare.length);
    expect(noFlags.x).toEqual({});
    expect(noFlags.h).toBe(full.h);
    const header = encodeMemory(emptyMemory("opportunist"), 4000);
    expect(fits(header.length)).toEqual(emptyMemory("opportunist"));
    expect(encodeMemory(full, header.length - 1)).toBe("");
  });

  test("always fits the cap and parses back to a prefix-trimmed copy", () => {
    const memory = fc.record({
      s: fc.constant("expander"),
      h: fc.option(fc.string({ maxLength: 40 }), { nil: null }),
      f: fc.dictionary(
        fc.integer({ min: 1, max: 99 }).map((n) => `i${n}`),
        fc.nat(),
      ),
      m: fc.array(fc.string({ maxLength: 120 }), { maxLength: 24 }),
      x: fc.dictionary(fc.stringMatching(/^[a-z][a-z0-9]{0,6}$/), fc.nat()),
      k: fc.array(fc.string({ maxLength: 24 }), { maxLength: 32 }),
    });
    fc.assert(
      fc.property(memory, fc.integer({ min: 0, max: 5000 }), (mem, cap) => {
        const text = encodeMemory(mem, cap);
        expect(text.length).toBeLessThanOrEqual(cap);
        if (text === "") return;
        const back = parseMemory(text, "expander");
        expect(mem.k.slice(mem.k.length - back.k.length)).toEqual([...back.k]);
        expect(mem.m.slice(mem.m.length - back.m.length)).toEqual([...back.m]);
        for (const [k, v] of Object.entries(back.f)) expect(mem.f[k]).toBe(v);
        for (const [k, v] of Object.entries(back.x)) expect(mem.x[k]).toBe(v);
      }),
    );
  });
});
