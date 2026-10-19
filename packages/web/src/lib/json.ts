// Narrowing for ruleset `ext` objects (JSON the skins read): the web imports no Zod of its own, and
// an `ext` field that is missing or of another shape reads as absent, never as an error.

export type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [k: string]: Json };
export type JsonRecord = { readonly [k: string]: Json };

export function isRecord(v: unknown): v is JsonRecord {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function field(o: unknown, key: string): unknown {
  return isRecord(o) && Object.hasOwn(o, key) ? o[key] : undefined;
}

export function numOf(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function strOf(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export function boolOf(v: unknown): boolean {
  return v === true;
}

export function arrOf(v: unknown): readonly unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Strings of an array, others dropped. */
export function strsOf(v: unknown): string[] {
  return arrOf(v).filter((x): x is string => typeof x === "string");
}

/** A game time written as a number or as a time pair `[t, "D3 14:57"]`. */
export function timeOf(v: unknown): number | null {
  if (Array.isArray(v)) return numOf(v[0]);
  return numOf(v);
}

/** JSON nested deeper than this is shown as written. */
export const PRETTY_MAX_DEPTH = 32;
/** Indented JSON may be this long, or 4 times its text when that is more; longer, as written. */
export const PRETTY_MAX_CHARS = 65_536;

/**
 * The length the indented form of a JSON text `t` (`JSON.stringify(JSON.parse(t), null, 2)`) can
 * reach through its layout: the text, a line break and twice the depth in spaces at each bracket
 * and comma, a space after each colon (a value written again can still grow, such as `1e20` or a
 * lone surrogate: `prettyJson` checks its result too); `Infinity` when `t` nests deeper than
 * `maxDepth`. One pass, nothing built.
 */
export function indentBound(t: string, maxDepth = PRETTY_MAX_DEPTH): number {
  let depth = 0;
  let deepest = 0;
  let breaks = 0;
  let colons = 0;
  let inString = false;
  for (let i = 0; i < t.length; i += 1) {
    const c = t.charCodeAt(i);
    if (inString) {
      if (c === 0x5c) i += 1;
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) {
      inString = true;
    } else if (c === 0x5b || c === 0x7b) {
      depth += 1;
      breaks += 1;
      if (depth > deepest) {
        deepest = depth;
        if (deepest > maxDepth) return Infinity;
      }
    } else if (c === 0x5d || c === 0x7d) {
      depth -= 1;
      breaks += 1;
    } else if (c === 0x2c) {
      breaks += 1;
    } else if (c === 0x3a) {
      colons += 1;
    }
  }
  return t.length + breaks * (2 * deepest + 1) + colons;
}

/**
 * A notebook that is a JSON object or array (a scripted bot's memory), indented for reading; null
 * for any other text (an agent's notes stay as written), and for JSON whose indented form could be
 * much larger than its text (deep nesting: each level indents every line below it), which an agent
 * could write to make every viewer's page lay out megabytes.
 */
export function prettyJson(text: string): string | null {
  const t = text.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return null;
  const limit = Math.max(PRETTY_MAX_CHARS, 4 * t.length);
  // Deep or wide nesting is refused before anything is built; the result is checked as well.
  if (indentBound(t) > limit) return null;
  try {
    const v: unknown = JSON.parse(t);
    if (v === null || typeof v !== "object") return null;
    const out = JSON.stringify(v, null, 2);
    return out.length <= limit ? out : null;
  } catch {
    return null;
  }
}
