// A structural diff of two JSON values (docs/architecture.md §12.1, `verify --dump`): the paths where
// they differ, in a deterministic order (object keys by code unit, array elements by index), up to a
// limit. Each entry names one path and the two values there, abbreviated.

export interface DiffEntry {
  /** `cities.c3.units.guard`, `queue[4].at`; `(root)` for the values themselves. */
  readonly path: string;
  /** Compact JSON of the value on each side, abbreviated; `(missing)` when absent. */
  readonly expected: string;
  readonly actual: string;
}

export interface JsonDiff {
  readonly entries: DiffEntry[];
  /** More paths differ than `limit`. */
  readonly truncated: boolean;
}

export const MISSING = "(missing)";
const MAX_VALUE_CHARS = 120;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function text(v: unknown): string {
  if (v === undefined) return MISSING;
  const s = JSON.stringify(v) ?? "undefined";
  return s.length > MAX_VALUE_CHARS ? `${s.slice(0, MAX_VALUE_CHARS - 1)}…` : s;
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function child(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(key)
    ? `${path}${path === "" ? "" : "."}${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

/** The paths where `expected` and `actual` differ, at most `limit` of them. */
export function jsonDiff(expected: unknown, actual: unknown, limit = 20): JsonDiff {
  const entries: DiffEntry[] = [];
  let truncated = false;
  const add = (path: string, a: unknown, b: unknown): boolean => {
    if (entries.length >= limit) {
      truncated = true;
      return false;
    }
    entries.push({ path: path === "" ? "(root)" : path, expected: text(a), actual: text(b) });
    return true;
  };
  const walk = (path: string, a: unknown, b: unknown): boolean => {
    if (Array.isArray(a) && Array.isArray(b)) {
      const n = Math.max(a.length, b.length);
      for (let i = 0; i < n; i += 1) {
        const p = `${path}[${i}]`;
        if (i >= a.length || i >= b.length) {
          if (!add(p, a[i], b[i])) return false;
        } else if (!walk(p, a[i], b[i])) return false;
      }
      return true;
    }
    if (isRecord(a) && isRecord(b)) {
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].toSorted(byCodeUnit);
      for (const k of keys) {
        const inA = Object.hasOwn(a, k);
        const inB = Object.hasOwn(b, k);
        const p = child(path, k);
        if (!inA || !inB) {
          if (!add(p, inA ? a[k] : undefined, inB ? b[k] : undefined)) return false;
        } else if (!walk(p, a[k], b[k])) return false;
      }
      return true;
    }
    if (Object.is(a, b)) return true;
    return add(path, a, b);
  };
  walk("", expected, actual);
  return { entries, truncated };
}
