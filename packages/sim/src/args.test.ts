// Command-line plumbing (docs/architecture.md §12.1): flag parsing, the usage errors and the
// parsers of seeds, speeds and latency ranges.

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  UsageError,
  parseFlags,
  parseIntIn,
  parseLatency,
  parseSeeds,
  parseSpeed,
  usageText,
  type FlagSpecs,
} from "./args.ts";

const SPECS: FlagSpecs = {
  seed: { type: "string", value: "<uint32>", help: "the seed" },
  override: { type: "string", repeat: true, value: "<k=v>", help: "an override" },
  quiet: { type: "boolean", help: "be quiet" },
};
const USAGE = usageText("sim x [flags]", SPECS);

/** The error `parseFlags` throws for `argv`, or null. */
function run(argv: string[], max = 0): unknown {
  try {
    parseFlags(argv, SPECS, USAGE, { min: 0, max, name: "target" });
    return null;
  } catch (error) {
    return error;
  }
}

describe("flags", () => {
  test("strings, repeatable strings, booleans and positionals", () => {
    const f = parseFlags(
      ["a", "--seed", "4", "--override", "x=1", "--override=y=2", "--quiet"],
      SPECS,
      USAGE,
      { min: 1, max: 1, name: "target" },
    );
    expect(f.string("seed")).toBe("4");
    expect(f.strings("override")).toEqual(["x=1", "y=2"]);
    expect(f.bool("quiet")).toBe(true);
    expect(f.positionals).toEqual(["a"]);
    expect(f.has("seed")).toBe(true);
    const none = parseFlags([], SPECS, USAGE, { min: 0, max: 0, name: "target" });
    expect(none.string("seed")).toBeUndefined();
    expect(none.strings("override")).toEqual([]);
    expect(none.bool("quiet")).toBe(false);
  });

  test("an unknown flag, a missing value, a repeated flag and a wrong positional count are usage errors listing the flags", () => {
    for (const argv of [
      ["--nope"],
      ["--seed"],
      ["--seed", "1", "--seed", "2"],
      ["x"],
      ["--quiet=1"],
    ]) {
      const error = run(argv);
      expect(error).toBeInstanceOf(UsageError);
    }
    expect(String(run(["--nope"]))).toContain("--override <k=v>  an override (repeatable)");
    expect(String(run(["--seed", "1", "--seed", "2"]))).toContain("--seed is given 2 times");
    expect(String(run(["x", "y"], 1))).toContain("expected 0 to 1 target argument(s), got 2 (x y)");
  });
});

describe("values", () => {
  test("integers within a range", () => {
    expect(parseIntIn("0", "--seed", 0, 10)).toBe(0);
    expect(parseIntIn("10", "--seed", 0, 10)).toBe(10);
    for (const bad of ["-1", "11", "1.5", "01", "", "1e3", " 1"]) {
      expect(() => parseIntIn(bad, "--seed", 0, 10)).toThrow(UsageError);
    }
  });

  test("seeds: ranges, lists and mixes, distinct, uint32", () => {
    expect(parseSeeds("1-10")).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(parseSeeds("1,5,9")).toEqual([1, 5, 9]);
    expect(parseSeeds("1-3,7")).toEqual([1, 2, 3, 7]);
    expect(parseSeeds("4294967295")).toEqual([4294967295]);
    expect(() => parseSeeds("3-1")).toThrow("empty");
    expect(() => parseSeeds("1,1")).toThrow("listed twice");
    expect(() => parseSeeds("1-3,2")).toThrow("listed twice");
    expect(() => parseSeeds("4294967296")).toThrow(UsageError);
    expect(() => parseSeeds("0-20000")).toThrow("at most 10000");
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.nat({ max: 0xffffffff }), { minLength: 1, maxLength: 20 }),
        (xs) => {
          expect(parseSeeds(xs.join(","))).toEqual(xs);
        },
      ),
    );
  });

  test("speeds and latency ranges", () => {
    expect(parseSpeed("3")).toEqual({ num: 3, den: 1 });
    expect(parseSpeed("5/2")).toEqual({ num: 5, den: 2 });
    for (const bad of ["0", "3/0", "x", "1.5", "-3"])
      expect(() => parseSpeed(bad)).toThrow(UsageError);
    expect(parseLatency("2000-60000")).toEqual([2000, 60000]);
    expect(parseLatency("0-0")).toEqual([0, 0]);
    for (const bad of ["60000-2000", "100", "a-b", "-1-5"]) {
      expect(() => parseLatency(bad)).toThrow(UsageError);
    }
  });
});
