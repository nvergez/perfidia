import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { insertSorted, removeWhere } from "./sorted.ts";

interface Item {
  key: number;
  id: number;
}

const byKey = (a: Item, b: Item): number => a.key - b.key;
const byNumber = (a: number, b: number): number => a - b;

describe("insertSorted", () => {
  test("keeps the array sorted and equal keys in insertion order (a stable sort)", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 20 }), { maxLength: 200 }), (keys) => {
        const arr: Item[] = [];
        keys.forEach((key, id) => {
          const index = insertSorted(arr, { key, id }, byKey);
          expect(arr[index]).toEqual({ key, id });
        });
        const expected = keys.map((key, id) => ({ key, id })).toSorted(byKey);
        expect(arr).toEqual(expected);
      }),
      { numRuns: 1000 },
    );
  });

  test("returns the insertion index at both ends and in the middle", () => {
    const arr = [10, 20, 30];
    expect(insertSorted(arr, 5, byNumber)).toBe(0);
    expect(insertSorted(arr, 35, byNumber)).toBe(4);
    expect(insertSorted(arr, 20, byNumber)).toBe(3);
    expect(arr).toEqual([5, 10, 20, 20, 30, 35]);
    const empty: number[] = [];
    expect(insertSorted(empty, 1, byNumber)).toBe(0);
    expect(empty).toEqual([1]);
  });

  test("orders a queue by (at, cls, seq) like the kernel's", () => {
    type Ev = { at: number; cls: number; seq: number };
    const cmp = (a: Ev, b: Ev): number => a.at - b.at || a.cls - b.cls || a.seq - b.seq;
    const queue: Ev[] = [];
    for (const ev of [
      { at: 7200, cls: 7, seq: 3 },
      { at: 3600, cls: 1, seq: 4 },
      { at: 7200, cls: 2, seq: 5 },
      { at: 7200, cls: 7, seq: 1 },
    ]) {
      insertSorted(queue, ev, cmp);
    }
    expect(queue.map((ev) => ev.seq)).toEqual([4, 5, 1, 3]);
  });
});

describe("removeWhere", () => {
  test("removes exactly the matching items, in place, keeping both orders", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -50, max: 50 })),
        fc.integer({ min: 2, max: 5 }),
        (values, m) => {
          const arr = values.slice();
          const pred = (x: number): boolean => x % m === 0;
          const removed = removeWhere(arr, pred);
          expect(arr).toEqual(values.filter((x) => !pred(x)));
          expect(removed).toEqual(values.filter(pred));
        },
      ),
      { numRuns: 1000 },
    );
  });

  test("keeps the same array object and returns [] when nothing matches", () => {
    const arr = [1, 2, 3];
    const same = arr;
    expect(removeWhere(arr, (x) => x > 5)).toEqual([]);
    expect(arr).toBe(same);
    expect(arr).toEqual([1, 2, 3]);
    expect(removeWhere(arr, () => true)).toEqual([1, 2, 3]);
    expect(arr).toEqual([]);
  });
});
