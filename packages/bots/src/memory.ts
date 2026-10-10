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
  /** Founding movements in flight: target island → arrival time. Own `found` movements do not show it. */
  readonly f: Readonly<Record<string, number>>;
  /** Free-form memo lines, oldest first (e.g. `ally p3 since D1`). */
  readonly m: readonly string[];
  /** Strategy flags and counters by short name. */
  readonly x: Readonly<Record<string, number>>;
  /** Ids already handled (e.g. incoming attacks already answered), oldest first. */
  readonly k: readonly string[];
}

export const MEMORY_VERSION = 1;
const MAX_MEMO = 24;
const MAX_HANDLED = 32;

const Int = z.int().nonnegative();
const MemorySchema = z.strictObject({
  v: z.literal(MEMORY_VERSION),
  s: z.string().max(32),
  h: z.string().max(40).nullable(),
  f: z.record(z.string().regex(/^i[1-9][0-9]*$/), Int),
  m: z.array(z.string().max(120)).max(MAX_MEMO),
  x: z.record(z.string().regex(/^[a-z][a-z0-9]*$/), Int),
  k: z.array(z.string().max(24)).max(MAX_HANDLED),
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

function sortedRecord(
  record: Readonly<Record<string, number>>,
  cmp: (a: string, b: string) => number,
): Record<string, number> {
  const out: Record<string, number> = {};
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
 * Compact JSON for `mem` within `maxChars` (deterministic key order). When it does not fit, the
 * least useful parts go first: handled ids and memo lines (oldest first), then foundings (latest
 * arrival first), then flags; if even the bare header is too long, the empty string.
 */
export function encodeMemory(mem: Memory, maxChars: number): string {
  const k = mem.k.slice(-MAX_HANDLED);
  const m = mem.m.slice(-MAX_MEMO);
  const f: Record<string, number> = { ...mem.f };
  const x: Record<string, number> = { ...mem.x };
  let h = mem.h;
  const current = (): Memory => ({ s: mem.s, h, f, m, x, k });
  let text = render(current());
  while (text.length > maxChars) {
    if (k.length > 0) {
      k.shift();
    } else if (m.length > 0) {
      m.shift();
    } else if (Object.keys(f).length > 0) {
      const latest = Object.keys(f).toSorted((a, b) => f[b]! - f[a]! || compareIds(b, a))[0]!;
      delete f[latest];
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
