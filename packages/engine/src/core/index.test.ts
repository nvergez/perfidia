import { expect, test } from "bun:test";
import * as engine from "@perfidia/engine";
import * as core from "@perfidia/engine/core";

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const CORE_EXPORTS = [
  "CanonicalJsonError",
  "DAY",
  "OPAQUE_ALPHABET",
  "OPAQUE_MAX_COUNTER",
  "OPAQUE_MAX_OWNER",
  "assertSafeInt",
  "canonicalJson",
  "cas",
  "ceilDiv",
  "clamp",
  "createOpaqueIdMinter",
  "floorDiv",
  "fmt",
  "fmtDuration",
  "fmtTime",
  "fnv1a32",
  "fnv1a64",
  "idKeyFromSeed",
  "insertSorted",
  "ipow",
  "isqrt",
  "lossPm",
  "mulDiv",
  "mulberry32",
  "opaqueId",
  "randInt",
  "rdiv",
  "removeWhere",
  "sha256Hex",
  "sha256Words",
  "shuffle",
  "streamRng",
  "utf8Encode",
];

test("@perfidia/engine/core exposes the whole core API", () => {
  expect(Object.keys(core).toSorted(byCodeUnit)).toEqual(CORE_EXPORTS.toSorted(byCodeUnit));
});

test("the engine top barrel re-exports core and keeps ENGINE_PACKAGE", () => {
  for (const name of CORE_EXPORTS) expect(Reflect.get(engine, name)).toBe(Reflect.get(core, name));
  expect(engine.ENGINE_PACKAGE).toBe("@perfidia/engine");
  expect("ENGINE_UPSTREAM" in engine).toBe(false);
});
