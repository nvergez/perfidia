// Bot memory in the notebook (docs/architecture.md §11.1): compact JSON within the cap; anything it
// cannot parse is empty memory; whatever the writers put in, the text written parses back.

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  emptyMemory,
  encodeMemory,
  HANDLED_MAX_CHARS,
  MEMO_MAX_CHARS,
  normalizeMemory,
  parseMemory,
  type Memory,
} from "./memory.ts";

const full: Memory = {
  s: "opportunist",
  h: "0123456789abcdef:6",
  f: { i12: [50000], i3: [40000, 41000] },
  m: ["ally p2 since D1", "pact p4 since D2"],
  x: { pr: 1, tr: 1, bt: 4 },
  k: ["tm0k4qz", "q0000a"],
};

describe("memory", () => {
  test("round-trips through its compact JSON, keys in a fixed order", () => {
    const text = encodeMemory(full, 4000);
    expect(parseMemory(text, "opportunist")).toEqual(full);
    expect(text).toBe(
      '{"v":2,"s":"opportunist","h":"0123456789abcdef:6","f":{"i3":[40000,41000],"i12":[50000]},' +
        '"m":["ally p2 since D1","pact p4 since D2"],"x":{"bt":4,"pr":1,"tr":1},"k":["tm0k4qz","q0000a"]}',
    );
    // Insertion order does not matter, nor the order of an island's arrivals.
    const shuffled: Memory = {
      ...full,
      f: { i3: [41000, 40000], i12: [50000] },
      x: { tr: 1, bt: 4, pr: 1 },
    };
    expect(encodeMemory(shuffled, 4000)).toBe(text);
  });

  test("a notebook it cannot read is empty memory", () => {
    const notes = [
      "",
      "Plan: attack p3 at dawn.",
      "{",
      "null",
      "[1,2]",
      '{"v":1,"s":"opportunist","h":null,"f":{},"m":[],"x":{},"k":[]}',
      '{"v":2,"s":"opportunist","h":null,"f":{"i3":4},"m":[],"x":{},"k":[]}',
      '{"v":2,"s":"opportunist","h":null,"f":{"i3":[]},"m":[],"x":{},"k":[]}',
      '{"v":2,"s":"opportunist","h":null,"f":{"x9":[1]},"m":[],"x":{},"k":[]}',
      '{"v":2,"s":"opportunist","h":null,"f":{},"m":[],"x":{"BT":1},"k":[]}',
      '{"v":2,"s":"opportunist","h":null,"f":{},"m":[],"x":{},"k":[],"extra":1}',
      '{"v":2,"s":"opportunist","h":null,"f":{"__proto__":{"polluted":1}},"m":[],"x":{},"k":[]}',
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
    // Foundings go latest arrival first, one arrival at a time.
    const noMemo = encodeMemory({ ...full, m: [], k: [] }, 4000);
    expect(fits(noMemo.length - 1).f).toEqual({ i3: [40000, 41000] });
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
        fc.array(fc.nat(), { minLength: 1, maxLength: 3 }).map((a) => a.toSorted((x, y) => x - y)),
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
        for (const [k, v] of Object.entries(back.f)) {
          expect(mem.f[k]?.slice(0, v.length)).toEqual([...v]);
        }
        for (const [k, v] of Object.entries(back.x)) expect(mem.x[k]).toBe(v);
      }),
    );
  });

  test("-0 is stored as 0, in flags and in arrival times", () => {
    const signed: Memory = { ...emptyMemory("rusher"), f: { i3: [-0, 5] }, x: { a: -0, b: 2 } };
    const clean = normalizeMemory(signed);
    expect(clean.x).toEqual({ a: 0, b: 2 });
    expect(clean.f).toEqual({ i3: [0, 5] });
    const back = parseMemory(encodeMemory(signed, 4000), "rusher");
    expect(back).toEqual(clean);
    expect(Object.is(back.x.a, 0)).toBe(true);
    expect(Object.is(back.f.i3?.[0], 0)).toBe(true);
  });

  test("whatever the writers put in, the text parses back and keeps every valid entry", () => {
    // Anything a buggy writer could produce: long lines and ids, bad flag names and values (-0
    // among them), bad island keys and arrival times, a long rules key.
    const anyNumber = fc.oneof(
      fc.nat(),
      fc.constant(-0),
      fc.integer({ min: -1000, max: -1 }),
      fc.double({ noNaN: false }),
      fc.constant(Number.MAX_SAFE_INTEGER + 2),
    );
    const memory = fc.record({
      s: fc.constant("rusher"),
      h: fc.option(fc.string({ maxLength: 60 }), { nil: null }),
      f: fc.dictionary(
        fc.oneof(
          fc.integer({ min: 1, max: 99 }).map((n) => `i${n}`),
          fc.string({ maxLength: 4 }),
        ),
        fc.array(anyNumber, { maxLength: 10 }),
      ),
      m: fc.array(fc.string({ maxLength: 300 }), { maxLength: 30 }),
      x: fc.dictionary(fc.string({ maxLength: 8 }), anyNumber),
      k: fc.array(fc.string({ maxLength: 60 }), { maxLength: 40 }),
    });
    fc.assert(
      fc.property(memory, (mem) => {
        const text = encodeMemory(mem, 100_000);
        const back = parseMemory(text, "rusher");
        // Nothing is lost but what the format cannot hold.
        const clean = normalizeMemory(mem);
        expect(back).toEqual({ ...clean, m: clean.m.slice(-24), k: clean.k.slice(-32) });
        for (const line of back.m) expect(line.length).toBeLessThanOrEqual(MEMO_MAX_CHARS);
        for (const id of back.k) expect(id.length).toBeLessThanOrEqual(HANDLED_MAX_CHARS);
        // Every storable flag survives, -0 as 0 (JSON has no -0).
        for (const [name, value] of Object.entries(mem.x)) {
          if (/^[a-z][a-z0-9]*$/.test(name) && Number.isSafeInteger(value) && value >= 0) {
            expect(back.x[name]).toBe(value === 0 ? 0 : value);
          }
        }
      }),
    );
  });
});
