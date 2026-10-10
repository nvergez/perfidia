import { expect, test } from "bun:test";
import * as core from "@perfidia/engine/core";
import * as canonical from "./canonical.ts";
import * as format from "./format.ts";
import * as hash from "./hash.ts";
import * as int from "./int.ts";
import * as opaque from "./opaque.ts";
import * as prng from "./prng.ts";
import * as sorted from "./sorted.ts";

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The runtime exports of each core module, laid out as architecture.md §15.3 (T03) and §6 place them. */
const CORE_LAYOUT: readonly [object, readonly string[]][] = [
  [canonical, ["CanonicalJsonError", "canonicalJson"]],
  [format, ["DAY", "fmt", "fmtDuration", "fmtTime"]],
  [hash, ["fnv1a64", "sha256Hex", "sha256Words", "utf8Encode"]],
  [
    int,
    [
      "assertSafeInt",
      "cas",
      "ceilDiv",
      "clamp",
      "floorDiv",
      "ipow",
      "isqrt",
      "lossPm",
      "mulDiv",
      "rdiv",
    ],
  ],
  [
    opaque,
    [
      "OPAQUE_ALPHABET",
      "OPAQUE_MAX_COUNTER",
      "OPAQUE_MAX_OWNER",
      "createOpaqueIdMinter",
      "idKeyFromSeed",
      "opaqueId",
    ],
  ],
  [prng, ["fnv1a32", "mulberry32", "randInt", "shuffle", "streamRng"]],
  [sorted, ["insertSorted", "removeWhere"]],
];

test("each core module exports exactly its share of the core API", () => {
  for (const [mod, names] of CORE_LAYOUT) {
    expect(Object.keys(mod).toSorted(byCodeUnit)).toEqual(names.toSorted(byCodeUnit));
  }
});

test("@perfidia/engine/core exposes the whole core API, each name bound to its module's value", () => {
  const all = CORE_LAYOUT.flatMap(([, names]) => names);
  expect(Object.keys(core).toSorted(byCodeUnit)).toEqual(all.toSorted(byCodeUnit));
  for (const [mod, names] of CORE_LAYOUT) {
    for (const name of names) expect(Reflect.get(core, name)).toBe(Reflect.get(mod, name));
  }
});
