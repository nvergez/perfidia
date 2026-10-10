// Seeded randomness (docs/architecture.md §6.2, perfidia-1 §1.3): mulberry32 on named streams.
// No PRNG state lives in the game state; a stream is rebuilt from the match seed and its name.

import { fnv1a32 } from "./hash.ts";
import { assertSafeInt } from "./int.ts";

/** A source of uint32 values (structurally identical to the `Rng` of `contracts`). */
export interface Rng {
  nextU32(): number;
}

const UINT32_RANGE = 4294967296;
/** `randInt` spans at most 2^21 values, so `u · span` stays below 2^53. */
const MAX_RANDINT_SPAN = 2097152;

function assertUint32(n: number, what: string): void {
  if (!Number.isInteger(n) || n < 0 || n >= UINT32_RANGE) {
    throw new RangeError(`${what} must be a uint32, got ${n}`);
  }
}

/** mulberry32 seeded with the uint32 `seed`, exactly as perfidia-1 §1.3. */
export function mulberry32(seed: number): Rng {
  assertUint32(seed, "mulberry32 seed");
  let s = seed;
  return {
    nextU32(): number {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return (t ^ (t >>> 14)) >>> 0;
    },
  };
}

/**
 * The stream `name` of the match seeded with `seed` (a uint32): mulberry32 seeded with the FNV-1a 32
 * of `${seed}:${name}`. Streams are independent: drawing from one never shifts another.
 */
export function streamRng(seed: number, name: string): Rng {
  assertUint32(seed, "match seed");
  return mulberry32(fnv1a32(`${seed}:${name}`));
}

/** `lo + floor(u · (hi − lo + 1) / 2^32)` for the next output u; needs lo ≤ hi and hi − lo < 2^21. */
export function randInt(rng: Rng, lo: number, hi: number): number {
  assertSafeInt(lo, "randInt lower bound");
  assertSafeInt(hi, "randInt upper bound");
  if (lo > hi) throw new RangeError(`randInt bounds out of order: ${lo} > ${hi}`);
  const span = hi - lo + 1;
  if (span > MAX_RANDINT_SPAN) {
    throw new RangeError(`randInt span ${span} exceeds 2^21 (bounds ${lo}..${hi})`);
  }
  const u = rng.nextU32();
  assertUint32(u, "Rng output");
  return lo + Math.floor((u * span) / UINT32_RANGE);
}

/**
 * A shuffled copy of `list` (the input is left untouched): Fisher–Yates from the end, swapping
 * index i with `j = randInt(rng, 0, i)` for i = n − 1 down to 1.
 */
export function shuffle<T>(rng: Rng, list: readonly T[]): T[] {
  const out = list.slice();
  for (let i = out.length - 1; i >= 1; i -= 1) {
    const j = randInt(rng, 0, i);
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}
