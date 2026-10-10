// Bot memory (docs/architecture.md §11.1): bots are stateless across wakes, so whatever must outlive
// a turn is written to the seat's notebook as compact JSON, within `notesMaxChars`. A bot may take
// over a seat mid-match, so a notebook it cannot parse (empty, free text written by an LLM, another
// bot's format, or full) is read as empty memory and rewritten, never an error.

import { compareIds, z } from "@perfidia/protocol";

/** What a bot remembers between wakes. Keys are short: the notebook is shared with the briefing budget. */
export interface Memory {
  /** The strategy that wrote it. */
  readonly s: string;
  /** Cache key of the rules the bot read (`<configHash prefix>:<players>`), or null. */
  readonly h: string | null;
  /**
   * Founding movements in flight: target island → their arrival times, earliest first (several
   * founders may head for one island). Own `found` movements do not show their island.
   */
  readonly f: Readonly<Record<string, readonly number[]>>;
  /** Free-form memo lines, oldest first (e.g. `ally p3 since D1`). */
  readonly m: readonly string[];
  /** Strategy flags and counters by short name. */
  readonly x: Readonly<Record<string, number>>;
  /** Ids already handled (e.g. incoming attacks already answered), oldest first. */
  readonly k: readonly string[];
}

export const MEMORY_VERSION = 2;
const MAX_MEMO = 24;
const MAX_HANDLED = 32;
/** Longest memo line, handled id, strategy name and rules key the format keeps. */
export const MEMO_MAX_CHARS = 120;
export const HANDLED_MAX_CHARS = 24;
const STRATEGY_MAX_CHARS = 32;
const KEY_MAX_CHARS = 40;
/** Foundings remembered per island. */
const MAX_FOUNDINGS = 8;

const ISLAND_KEY = /^i[1-9][0-9]*$/;
const FLAG_NAME = /^[a-z][a-z0-9]*$/;

const Int = z.int().nonnegative();
const MemorySchema = z.strictObject({
  v: z.literal(MEMORY_VERSION),
  s: z.string().max(STRATEGY_MAX_CHARS),
  h: z.string().max(KEY_MAX_CHARS).nullable(),
  f: z.record(z.string().regex(ISLAND_KEY), z.array(Int).min(1).max(MAX_FOUNDINGS)),
  m: z.array(z.string().max(MEMO_MAX_CHARS)).max(MAX_MEMO),
  x: z.record(z.string().regex(FLAG_NAME), Int),
  k: z.array(z.string().max(HANDLED_MAX_CHARS)).max(MAX_HANDLED),
});

/** Empty memory for `strategy`. */
export function emptyMemory(strategy: string): Memory {
  return { s: strategy, h: null, f: {}, m: [], x: {}, k: [] };
}

/**
 * Reads a notebook. Anything that is not this format, whole and valid, is empty memory for
 * `strategy`; so is memory written by another strategy (its flags would mean something else).
 */
export function parseMemory(notes: string, strategy: string): Memory {
  let raw: unknown;
  try {
    raw = JSON.parse(notes);
  } catch {
    return emptyMemory(strategy);
  }
  const parsed = MemorySchema.safeParse(raw);
  if (!parsed.success || parsed.data.s !== strategy) return emptyMemory(strategy);
  const { s, h, f, m, x, k } = parsed.data;
  return { s, h, f, m, x, k };
}

// Writers keep every entry within the format, so one bad value can never make the whole notebook
// unreadable (which would silently reset every flag).

/** A memo line as the format keeps it. */
export function memoLine(line: string): string {
  return line.slice(0, MEMO_MAX_CHARS);
}

/** A handled id as the format keeps it (ids are compared in this form). */
export function handledId(id: string): string {
  return id.slice(0, HANDLED_MAX_CHARS);
}

/** True when `name` can be a flag name. */
export function isFlagName(name: string): boolean {
  return FLAG_NAME.test(name);
}

/** True when `value` can be a flag value or an arrival time (a non-negative safe integer). */
export function isCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** `-0` as `0` (JSON writes both as `0`). */
const unsigned = (n: number): number => (n === 0 ? 0 : n);

/**
 * `mem` with every entry the format would reject dropped or cut: long memo lines and handled ids
 * are cut, invalid flags, islands and times are dropped, a long rules key becomes null.
 */
export function normalizeMemory(mem: Memory): Memory {
  const f: Record<string, number[]> = {};
  for (const [island, etas] of Object.entries(mem.f)) {
    if (!ISLAND_KEY.test(island)) continue;
    const ok = etas
      .filter(isCount)
      .map(unsigned)
      .toSorted((a, b) => a - b);
    if (ok.length > 0) f[island] = ok.slice(0, MAX_FOUNDINGS);
  }
  const x: Record<string, number> = {};
  for (const [name, value] of Object.entries(mem.x)) {
    if (isFlagName(name) && isCount(value)) x[name] = unsigned(value);
  }
  return {
    s: mem.s.slice(0, STRATEGY_MAX_CHARS),
    h: mem.h !== null && mem.h.length <= KEY_MAX_CHARS ? mem.h : null,
    f,
    m: mem.m.map(memoLine),
    x,
    k: mem.k.map(handledId),
  };
}

function sortedRecord<T>(
  record: Readonly<Record<string, T>>,
  cmp: (a: string, b: string) => number,
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(record).toSorted(cmp)) out[key] = record[key]!;
  return out;
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function render(mem: Memory): string {
  return JSON.stringify({
    v: MEMORY_VERSION,
    s: mem.s,
    h: mem.h,
    f: sortedRecord(mem.f, compareIds),
    m: mem.m.slice(-MAX_MEMO),
    x: sortedRecord(mem.x, byCodeUnit),
    k: mem.k.slice(-MAX_HANDLED),
  });
}

/**
 * Compact JSON for `mem` within `maxChars` (deterministic key order) that always parses back. Entries
 * the format rejects are dropped or cut first (`normalizeMemory`). When it does not fit, the least
 * useful parts go first: handled ids and memo lines (oldest first), then foundings (latest arrival
 * first), then flags; if even the bare header is too long, the empty string.
 */
export function encodeMemory(mem: Memory, maxChars: number): string {
  const clean = normalizeMemory(mem);
  const k = clean.k.slice(-MAX_HANDLED);
  const m = clean.m.slice(-MAX_MEMO);
  const f: Record<string, number[]> = {};
  for (const [island, etas] of Object.entries(clean.f)) f[island] = [...etas];
  const x: Record<string, number> = { ...clean.x };
  let h = clean.h;
  const current = (): Memory => ({ s: clean.s, h, f, m, x, k });
  let text = render(current());
  while (text.length > maxChars) {
    if (k.length > 0) {
      k.shift();
    } else if (m.length > 0) {
      m.shift();
    } else if (Object.keys(f).length > 0) {
      const latest = Object.keys(f).toSorted(
        (a, b) => f[b]!.at(-1)! - f[a]!.at(-1)! || compareIds(b, a),
      )[0]!;
      f[latest]!.pop();
      if (f[latest]!.length === 0) delete f[latest];
    } else if (Object.keys(x).length > 0) {
      delete x[Object.keys(x).toSorted(byCodeUnit).at(-1)!];
    } else if (h !== null) {
      h = null;
    } else {
      return "";
    }
    text = render(current());
  }
  return text;
}
