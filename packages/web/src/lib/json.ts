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

/**
 * A notebook that is a JSON object or array (a scripted bot's memory), indented for reading; null
 * for any other text (an agent's notes stay as written).
 */
export function prettyJson(text: string): string | null {
  const t = text.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return null;
  try {
    const v: unknown = JSON.parse(t);
    return v !== null && typeof v === "object" ? JSON.stringify(v, null, 2) : null;
  } catch {
    return null;
  }
}
