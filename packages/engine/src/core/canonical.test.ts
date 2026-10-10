import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { CanonicalJsonError, canonicalJson } from "./canonical.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const MAX = Number.MAX_SAFE_INTEGER;

const anyString = fc.oneof(
  fc.string(),
  fc.string({ unit: "binary" }),
  fc
    .array(fc.integer({ min: 0xd800, max: 0xdfff }), { maxLength: 3 })
    .map((units) => String.fromCharCode(...units)),
);

const { json } = fc.letrec<{ json: Json }>((tie) => ({
  json: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    fc.constant(null),
    fc.boolean(),
    fc.integer({ min: -MAX, max: MAX }),
    anyString,
    fc.array(tie("json"), { maxLength: 5 }),
    fc.dictionary(anyString, tie("json"), { maxKeys: 6 }),
  ),
}));

function isRecord(value: Json): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The same value with every object's keys inserted in reverse order, then rotated by `salt`. */
function reorder(value: Json, salt: number): Json {
  if (Array.isArray(value)) return value.map((item) => reorder(item, salt));
  if (!isRecord(value)) return value;
  const keys = Object.keys(value).toReversed();
  const shift = keys.length === 0 ? 0 : salt % keys.length;
  const rotated = [...keys.slice(shift), ...keys.slice(0, shift)];
  return Object.fromEntries(rotated.map((key) => [key, reorder(value[key] ?? null, salt + 1)]));
}

/** A straightforward reference: sorted keys by UTF-16 code unit, JSON.stringify for scalars. */
function reference(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(reference).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value);
  const keys = Object.keys(value).toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${keys.map((key) => `${JSON.stringify(key)}:${reference(value[key] ?? null)}`).join(",")}}`;
}

/** Every array and object inside `value`, the root included, in depth-first order. */
function containers(value: Json, out: (Json[] | { [key: string]: Json })[] = []) {
  if (Array.isArray(value)) {
    out.push(value);
    for (const item of value) containers(item, out);
  } else if (isRecord(value)) {
    out.push(value);
    for (const item of Object.values(value)) containers(item, out);
  }
  return out;
}

function rejection(value: unknown): CanonicalJsonError {
  try {
    canonicalJson(value);
  } catch (error) {
    if (error instanceof CanonicalJsonError) return error;
    throw error;
  }
  throw new Error(`canonicalJson accepted ${String(value)}`);
}

describe("canonicalJson: property P8", () => {
  test("ignores key insertion order", () => {
    fc.assert(
      fc.property(json, fc.nat(), (value, salt) => {
        expect(canonicalJson(reorder(value, salt))).toBe(canonicalJson(value));
      }),
      { numRuns: 2000 },
    );
  });

  test("is compact JSON that parses back to the same value, keys sorted by code unit", () => {
    fc.assert(
      fc.property(json, (value) => {
        const text = canonicalJson(value);
        expect(text).toBe(reference(value));
        expect(JSON.parse(text)).toEqual(value);
        expect(canonicalJson(JSON.parse(text))).toBe(text);
      }),
      { numRuns: 2000 },
    );
  });

  test("throws on any non-integer number, wherever it is", () => {
    const bad = fc.oneof(
      fc.double({ noInteger: true }),
      fc.constantFrom(
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        MAX + 1,
        -MAX - 1,
        1e21,
      ),
    );
    fc.assert(
      fc.property(json, bad, fc.nat(), (value, number, pick) => {
        const copy = structuredClone(value);
        const targets = containers(copy);
        const target = targets[pick % Math.max(1, targets.length)];
        let root: unknown = copy;
        if (target === undefined) root = [copy, number];
        else if (Array.isArray(target)) target.splice(pick % (target.length + 1), 0, number);
        else (target as Record<string, unknown>)[`bad${pick}`] = number;
        expect(() => canonicalJson(root)).toThrow(CanonicalJsonError);
      }),
      { numRuns: 2000 },
    );
  });
});

describe("canonicalJson: output", () => {
  test("sorts keys by UTF-16 code unit, not by code point or numeric value", () => {
    const value = { b: 1, a: 2, "10": 3, "2": 4, B: 5, é: 6, "\u{1f600}": 7, "￿": 8, "": 9 };
    expect(canonicalJson(value)).toBe(
      '{"":9,"10":3,"2":4,"B":5,"a":2,"b":1,"é":6,"\u{1f600}":7,"￿":8}',
    );
  });

  test("writes scalars like JSON.stringify, -0 as 0, and no whitespace", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(false)).toBe("false");
    expect(canonicalJson(-0)).toBe("0");
    expect(canonicalJson([-0, 0])).toBe("[0,0]");
    expect(canonicalJson(MAX)).toBe("9007199254740991");
    expect(canonicalJson(-MAX)).toBe("-9007199254740991");
    expect(canonicalJson('a"b\\c\n\u0001\ud800')).toBe(JSON.stringify('a"b\\c\n\u0001\ud800'));
    expect(canonicalJson({ list: [1, [2, { z: "x", y: [] }]], o: {} })).toBe(
      '{"list":[1,[2,{"y":[],"z":"x"}]],"o":{}}',
    );
  });

  test("omits undefined properties", () => {
    expect(canonicalJson({ a: undefined, b: 1, c: { d: undefined } })).toBe('{"b":1,"c":{}}');
  });

  test("accepts null-prototype objects, frozen objects and shared (acyclic) references", () => {
    const bare: Record<string, number> = { k: 1 };
    Object.setPrototypeOf(bare, null);
    expect(Object.getPrototypeOf(bare)).toBeNull();
    const shared = Object.freeze({ x: 1 });
    expect(canonicalJson({ bare, a: shared, b: [shared, shared] })).toBe(
      '{"a":{"x":1},"b":[{"x":1},{"x":1}],"bare":{"k":1}}',
    );
  });

  test("keeps __proto__ as an ordinary own key", () => {
    const value: unknown = JSON.parse('{"__proto__":{"a":1},"b":2}');
    expect(canonicalJson(value)).toBe('{"__proto__":{"a":1},"b":2}');
  });
});

describe("canonicalJson: each rejection of §6.3", () => {
  test("undefined at the top level, in an array, or as an array hole", () => {
    expect(rejection(undefined).path).toBe("$");
    expect(rejection([1, undefined]).path).toBe("$[1]");
    const holes: number[] = [];
    holes[2] = 1;
    expect(rejection({ list: holes }).path).toBe("$.list[0]");
  });

  test("floats, NaN, ±Infinity and integers beyond 2^53", () => {
    for (const bad of [
      1.5,
      -0.25,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      MAX + 1,
      -MAX - 1,
      1e300,
    ]) {
      expect(rejection({ a: [0, { b: bad }] }).path).toBe("$.a[1].b");
    }
    expect(rejection(0.1).message).toBe("canonicalJson: 0.1 is not a safe integer at $");
    expect(rejection({ "odd key": 1.5 }).path).toBe('$["odd key"]');
  });

  test("Map, Set, Date, class instances and boxed primitives", () => {
    class Point {
      x = 1;
    }
    // oxlint-disable-next-line no-restricted-globals -- a fixed Date instance, only to prove it is rejected
    const date = new Date(0);
    const cases: [unknown, string][] = [
      [new Map([["a", 1]]), "[object Map]"],
      [new Set([1]), "[object Set]"],
      [date, "[object Date]"],
      [new Point(), "[object Object]"],
      [Object(1), "[object Number]"],
      [new Uint8Array(2), "[object Uint8Array]"],
    ];
    for (const [value, tag] of cases) {
      const error = rejection({ v: value });
      expect(error.path).toBe("$.v");
      expect(error.message).toBe(`canonicalJson: ${tag} is not a plain object at $.v`);
    }
  });

  test("BigInt, functions and symbols, even as object properties", () => {
    expect(rejection(10n).message).toBe("canonicalJson: BigInt 10 is not JSON at $");
    expect(rejection({ f: () => 1 }).path).toBe("$.f");
    expect(rejection([Symbol("s")]).path).toBe("$[0]");
  });

  test("cyclic references", () => {
    const loop: Record<string, unknown> = { a: 1 };
    loop["self"] = loop;
    expect(rejection(loop).message).toBe("canonicalJson: cyclic reference at $.self");
    const list: unknown[] = [];
    list.push([list]);
    expect(rejection(list).path).toBe("$[0][0]");
  });

  test("a rejection is a TypeError carrying the path", () => {
    const error = rejection({ cities: { c3: { units: [1, 2, 0.5] } } });
    expect(error).toBeInstanceOf(TypeError);
    expect(error.name).toBe("CanonicalJsonError");
    expect(error.path).toBe("$.cities.c3.units[2]");
  });
});
