import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { sha256Hex } from "./hash.ts";
import {
  createOpaqueIdMinter,
  idKeyFromSeed,
  OPAQUE_ALPHABET,
  OPAQUE_MAX_COUNTER,
  opaqueId,
} from "./opaque.ts";

// The slow suite (PERFIDIA_SLOW=1: `bun run test:slow`, run by `bun run test:exit`; docs/
// architecture.md §13.8). Read through `import.meta.env`: the pure packages' tests may not name the
// `process` global.
const SLOW = import.meta.env["PERFIDIA_SLOW"] === "1";

const KEY_A = idKeyFromSeed(42);
const KEY_B = "0123456789abcdef0123456789abcdef";
const ID = /^[mrqg][0-9a-hjkmnp-tv-z]{5}$/;

/** The §4.1 pseudo-code, transcribed literally (hex digest, parseInt of its first 3 characters). */
function literalOpaqueId(idKey: string, prefix: string, owner: number, n: number): string {
  const v = n * 16 + owner;
  let L = v >>> 12;
  let R = v & 0xfff;
  for (let round = 0; round < 8; round += 1) {
    const F = Number.parseInt(sha256Hex(`${idKey}:${prefix}:${round}:${R}`).slice(0, 3), 16);
    [L, R] = [R, L ^ F];
  }
  let value = L * 4096 + R;
  let digits = "";
  for (let i = 0; i < 5; i += 1) {
    digits = `${OPAQUE_ALPHABET[value % 32] ?? "?"}${digits}`;
    value = Math.floor(value / 32);
  }
  return prefix + digits;
}

const prefix = fc.constantFrom("m", "r", "q", "g");
const owner = fc.integer({ min: 1, max: 15 });
const counter = fc.integer({ min: 1, max: OPAQUE_MAX_COUNTER });
const hexKey = fc.string({
  unit: fc.constantFrom(..."0123456789abcdef".split("")),
  minLength: 32,
  maxLength: 32,
});

describe("opaqueId", () => {
  test("matches committed vectors (computed independently in Python from the §4.1 pseudo-code)", () => {
    const vectors: [string, string, number, number, string][] = [
      [KEY_A, "m", 1, 1, "m9sanp"],
      [KEY_A, "m", 2, 1, "m9g7jh"],
      [KEY_A, "m", 1, 2, "m3qz70"],
      [KEY_A, "r", 3, 7, "r566v4"],
      [KEY_A, "q", 12, 1048575, "q3csjq"],
      [KEY_A, "g", 15, 65535, "g8kpda"],
      [KEY_A, "m", 15, 1, "m6hq0p"],
      [KEY_B, "m", 1, 1, "m55vxf"],
      [KEY_B, "m", 2, 1, "m2yzra"],
      [KEY_B, "m", 1, 2, "m4ka0j"],
      [KEY_B, "r", 3, 7, "r6avcw"],
      [KEY_B, "q", 12, 1048575, "qd678e"],
      [KEY_B, "g", 15, 65535, "g96n9c"],
      [KEY_B, "m", 15, 1, "mfjraj"],
    ];
    const minters = new Map([KEY_A, KEY_B].map((key) => [key, createOpaqueIdMinter(key)]));
    for (const [key, kind, who, n, id] of vectors) {
      expect(opaqueId(key, kind, who, n)).toBe(id);
      expect(minters.get(key)?.(kind, who, n)).toBe(id);
    }
  });

  test("equals the literal pseudo-code, and the memoised minter equals opaqueId", () => {
    fc.assert(
      fc.property(hexKey, prefix, owner, counter, (key, kind, who, n) => {
        const id = opaqueId(key, kind, who, n);
        expect(id).toBe(literalOpaqueId(key, kind, who, n));
        expect(createOpaqueIdMinter(key)(kind, who, n)).toBe(id);
        expect(id).toMatch(ID);
      }),
      { numRuns: 300 },
    );
  });

  test("has no collision over owners 1..15 × counters below 2^16 (2^12 outside the slow suite), using only the base-32 alphabet", () => {
    const below = SLOW ? 65536 : 4096;
    for (const key of [KEY_A, KEY_B]) {
      const mint = createOpaqueIdMinter(key);
      const seen = new Set<string>();
      for (let who = 1; who <= 15; who += 1) {
        for (let n = 1; n < below; n += 1) seen.add(mint("m", who, n));
      }
      expect(seen.size).toBe(15 * (below - 1));
      for (const id of seen) expect(ID.test(id)).toBe(true);
    }
  }, 30000);

  test("changes completely with the key, and with the prefix", () => {
    const a = createOpaqueIdMinter(KEY_A);
    const b = createOpaqueIdMinter(KEY_B);
    for (let who = 1; who <= 15; who += 1) {
      for (let n = 1; n <= 1000; n += 1) {
        expect(a("m", who, n)).not.toBe(b("m", who, n));
        expect(a("m", who, n).slice(1)).not.toBe(a("r", who, n).slice(1));
      }
    }
  });

  test("a player's ids depend only on the key and its own counter", () => {
    fc.assert(
      fc.property(hexKey, owner, counter, (key, who, n) => {
        const fresh = createOpaqueIdMinter(key);
        const used = createOpaqueIdMinter(key);
        for (let other = 1; other <= 15; other += 1) used("m", other, 1 + (n % 7));
        expect(used("m", who, n)).toBe(fresh("m", who, n));
      }),
      { numRuns: 100 },
    );
  });

  test("rejects counters outside 1..2^20 − 1, bad owners, prefixes and keys", () => {
    const mint = createOpaqueIdMinter(KEY_A);
    expect(OPAQUE_MAX_COUNTER).toBe(1048575);
    for (const call of [
      () => opaqueId(KEY_A, "m", 1, 1048576),
      () => mint("m", 1, 1048576),
      () => opaqueId(KEY_A, "m", 1, 0),
      () => opaqueId(KEY_A, "m", 1, 1.5),
      () => opaqueId(KEY_A, "m", 0, 1),
      () => opaqueId(KEY_A, "m", 16, 1),
      () => opaqueId(KEY_A, "M", 1, 1),
      () => opaqueId(KEY_A, "mm", 1, 1),
      () => opaqueId(KEY_A, "", 1, 1),
      () => opaqueId(KEY_A.toUpperCase(), "m", 1, 1),
      () => opaqueId(KEY_A.slice(1), "m", 1, 1),
      () => createOpaqueIdMinter("not a key"),
    ]) {
      expect(call).toThrow(RangeError);
    }
    expect(opaqueId(KEY_A, "m", 15, 1048575)).toMatch(ID);
  });
});

describe("idKeyFromSeed", () => {
  test("is sha256Hex('perfidia-idkey:' + seed).slice(0, 32): 32 lowercase hex characters", () => {
    expect(idKeyFromSeed(0)).toBe("b367af0063a5252f5bdb5a0f1a0cf436");
    expect(idKeyFromSeed(1)).toBe("daf3512e460bf8a30b03008c9119445a");
    expect(idKeyFromSeed(42)).toBe("eaea6004029a2d80151dd102f5f1722e");
    expect(idKeyFromSeed(4294967295)).toBe("b153d8e4ce19b1c1a8c06a186822a160");
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffffff }), (seed) => {
        const key = idKeyFromSeed(seed);
        expect(key).toMatch(/^[0-9a-f]{32}$/);
        expect(key).toBe(sha256Hex(`perfidia-idkey:${seed}`).slice(0, 32));
      }),
      { numRuns: 200 },
    );
  });

  test("rejects a seed that is not a uint32", () => {
    for (const bad of [-1, 4294967296, 0.5]) expect(() => idKeyFromSeed(bad)).toThrow(RangeError);
  });
});
