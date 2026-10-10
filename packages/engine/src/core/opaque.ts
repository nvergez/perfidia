// Opaque ids of the private kinds (docs/architecture.md §4.1): a keyed bijection of (owner, the
// owner's own counter) onto 24 bits, written as 5 characters of lowercase Crockford base 32. The
// key is the per-match secret `setup.idKey`, so ids reveal neither their owner nor their counter.

import { sha256Hex, sha256Words, utf8Encode } from "./hash.ts";
import { assertSafeInt } from "./int.ts";

/** Lowercase Crockford base 32: digits and letters without i, l, o, u. */
export const OPAQUE_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
/** Counters run from 1 to `OPAQUE_MAX_COUNTER`, i.e. n < 2^20. */
export const OPAQUE_MAX_COUNTER = 1048575;
/** Owners are player numbers 1..15 (the owner fills the low 4 bits). */
export const OPAQUE_MAX_OWNER = 15;

const ROUNDS = 8;
const ID_KEY = /^[0-9a-f]{32}$/;
const PREFIX = /^[a-z]$/;

/** Mints the opaque id of (prefix, owner, n). */
export type OpaqueIdMinter = (prefix: string, owner: number, n: number) => string;

function checkKey(idKey: string): void {
  if (!ID_KEY.test(idKey)) {
    throw new RangeError("idKey must be 32 lowercase hex characters");
  }
}

function checkArgs(prefix: string, owner: number, n: number): void {
  if (!PREFIX.test(prefix)) {
    throw new RangeError(
      `opaque id prefix must be one lowercase letter, got ${JSON.stringify(prefix)}`,
    );
  }
  assertSafeInt(owner, "opaque id owner");
  if (owner < 1 || owner > OPAQUE_MAX_OWNER) {
    throw new RangeError(`opaque id owner must be in 1..${OPAQUE_MAX_OWNER}, got ${owner}`);
  }
  assertSafeInt(n, "opaque id counter");
  if (n < 1 || n > OPAQUE_MAX_COUNTER) {
    throw new RangeError(`opaque id counter must be in 1..${OPAQUE_MAX_COUNTER}, got ${n}`);
  }
}

/**
 * The 12-bit round value `parseInt(sha256Hex(`${idKey}:${prefix}:${round}:${r}`).slice(0, 3), 16)`,
 * read directly from the top 12 bits of the first digest word.
 */
function roundValue(idKey: string, prefix: string, round: number, r: number): number {
  const first = sha256Words(utf8Encode(`${idKey}:${prefix}:${round}:${r}`))[0] ?? 0;
  return first >>> 20;
}

function mint(
  prefix: string,
  owner: number,
  n: number,
  f: (round: number, r: number) => number,
): string {
  const v = n * 16 + owner;
  let left = v >>> 12;
  let right = v & 0xfff;
  for (let round = 0; round < ROUNDS; round += 1) {
    const next = left ^ f(round, right);
    left = right;
    right = next;
  }
  let value = left * 4096 + right;
  let digits = "";
  for (let i = 0; i < 5; i += 1) {
    digits = OPAQUE_ALPHABET.charAt(value & 31) + digits;
    value >>>= 5;
  }
  return prefix + digits;
}

/**
 * The opaque id of the n-th id (1 ≤ n < 2^20) of kind `prefix` owned by player number `owner`
 * (1..15), under the 128-bit hex key `idKey`: an 8-round Feistel network on (n · 16 + owner) whose
 * round function is SHA-256 keyed by `idKey`. A bijection for every key and prefix, so ids never
 * collide; each call costs 8 SHA-256 blocks (see `createOpaqueIdMinter` for a memoised version).
 */
export function opaqueId(idKey: string, prefix: string, owner: number, n: number): string {
  checkKey(idKey);
  checkArgs(prefix, owner, n);
  return mint(prefix, owner, n, (round, r) => roundValue(idKey, prefix, round, r));
}

/**
 * `opaqueId` bound to one key, memoising the round values (at most 8 · 4096 per prefix). Meant to
 * live in one `Match` object, never in module state or in the game state (§4.1).
 */
export function createOpaqueIdMinter(idKey: string): OpaqueIdMinter {
  checkKey(idKey);
  const memo = new Map<number, number>();
  return (prefix, owner, n) => {
    checkArgs(prefix, owner, n);
    const base = (prefix.charCodeAt(0) - 97) * ROUNDS * 4096;
    return mint(prefix, owner, n, (round, r) => {
      const slot = base + round * 4096 + r;
      let value = memo.get(slot);
      if (value === undefined) {
        value = roundValue(idKey, prefix, round, r);
        memo.set(slot, value);
      }
      return value;
    });
  };
}

/**
 * A reproducible, non-secret id key for callers that need no secrecy (tests, goldens, bot batches):
 * `sha256Hex("perfidia-idkey:" + seed).slice(0, 32)` for the uint32 match seed.
 */
export function idKeyFromSeed(seed: number): string {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new RangeError(`seed must be a uint32, got ${seed}`);
  }
  return sha256Hex(`perfidia-idkey:${seed}`).slice(0, 32);
}
