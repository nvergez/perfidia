// Bot randomness (docs/architecture.md §11.1): the same algorithms as the engine's `core/prng.ts`
// (mulberry32 seeded by FNV-1a 32 over UTF-8, perfidia-1 §1.3), re-implemented here because bots
// import only `protocol` at runtime. A bot is a pure function of its inputs. It draws in two places
// only: its strategy parameters, once per match from the stream `(matchSeed, seat, strategy,
// "params")` (agent.ts), and its think time from `(matchSeed, seat, "think", t, turn, round)`
// (think.ts). Every per-turn choice is a deterministic function of the turn's inputs and of those
// parameters, so no per-round stream is needed.

/** A source of uint32 values. */
export interface BotRng {
  nextU32(): number;
}

const UINT32_RANGE = 4294967296;
/** `randInt` spans at most 2^21 values, so `u · span` stays an exact integer below 2^53. */
const MAX_SPAN = 2097152;

/** The UTF-8 bytes of `s`; a lone surrogate becomes U+FFFD, as `TextEncoder` does. */
function utf8(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c < 0xd800 || c > 0xdfff) {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (c <= 0xdbff && d >= 0xdc00 && d <= 0xdfff) {
        const cp = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        out.push(
          0xf0 | (cp >> 18),
          0x80 | ((cp >> 12) & 0x3f),
          0x80 | ((cp >> 6) & 0x3f),
          0x80 | (cp & 0x3f),
        );
        i += 1;
      } else {
        out.push(0xef, 0xbf, 0xbd);
      }
    }
  }
  return out;
}

/** FNV-1a 32 of the UTF-8 bytes of `s` (offset 2166136261, prime 16777619), as a uint32. */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (const byte of utf8(s)) h = Math.imul(h ^ byte, 16777619);
  return h >>> 0;
}

/** mulberry32 seeded with the uint32 `seed`, exactly as perfidia-1 §1.3. */
export function mulberry32(seed: number): BotRng {
  if (!Number.isInteger(seed) || seed < 0 || seed >= UINT32_RANGE) {
    throw new RangeError(`mulberry32 seed must be a uint32, got ${seed}`);
  }
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

/** The stream named by `parts` joined with `:`, e.g. `(seed, seat, t, turn, round)`. */
export function streamOf(...parts: readonly (string | number)[]): BotRng {
  return mulberry32(fnv1a32(parts.join(":")));
}

/** `lo + floor(u · (hi − lo + 1) / 2^32)` for the next output u; needs lo ≤ hi and a span ≤ 2^21. */
export function randInt(rng: BotRng, lo: number, hi: number): number {
  if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || lo > hi) {
    throw new RangeError(`randInt bounds must be integers with lo <= hi, got ${lo}..${hi}`);
  }
  const span = hi - lo + 1;
  if (span > MAX_SPAN) throw new RangeError(`randInt span ${span} exceeds 2^21`);
  return lo + Math.floor((rng.nextU32() * span) / UINT32_RANGE);
}
