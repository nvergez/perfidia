import type { DeepReadonly, Json, JsonObject } from "@perfidia/protocol";

// The one copy of the gateway's text cleaning and JSON copies, shared by the seat state (archive
// summaries, stored events) and the presentation (views, briefings, `read_notes`): player text is
// stripped the same way wherever an agent reads it (§8.2), and no stored or shown value aliases
// what the gateway received (§6.6).

/** A control character or line break: C0, DEL, C1, and the line and paragraph separators. */
function isControl(c: number): boolean {
  return c < 32 || (c >= 127 && c < 160) || c === 0x2028 || c === 0x2029;
}

/**
 * Replaces control characters and line breaks with a space, so player-authored text stays one
 * typed line (§8.2). Fixed code ranges, no Unicode tables (§6.5).
 */
export function stripControl(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i += 1) out += isControl(s.charCodeAt(i)) ? " " : s[i];
  return out;
}

/** `out[key] = value`, keeping a `__proto__` key as plain data instead of changing the prototype. */
export function setOwn(out: JsonObject, key: string, value: Json): void {
  Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
}

/** `Array.isArray` for read-only JSON (the built-in guard does not narrow read-only arrays). */
export function isJsonArray(value: DeepReadonly<Json>): value is readonly DeepReadonly<Json>[] {
  return Array.isArray(value);
}

/** A deep copy of a JSON value (own keys only; a `__proto__` key stays plain data). */
export function copyJson(value: DeepReadonly<Json>): Json {
  if (value === null || typeof value !== "object") return value;
  if (isJsonArray(value)) return value.map((v) => copyJson(v));
  return copyObject(value);
}

/** A deep copy of a JSON object (own keys only; a `__proto__` key stays plain data). */
export function copyObject(value: DeepReadonly<JsonObject>): JsonObject {
  const out: JsonObject = {};
  for (const key of Object.keys(value)) {
    const v = value[key];
    if (v !== undefined) setOwn(out, key, copyJson(v));
  }
  return out;
}
