import type { Json, JsonObject } from "@perfidia/protocol";

// Text hygiene for spectators (phase-3 design §2.6). Player-authored text (messages, proposals,
// thoughts, notes, reasoning) reaches viewers as plain text, so it keeps its line breaks; the
// gateway's `stripControl`, made for agents, flattens them and keeps bidi controls. Here:
// - `\r\n` and a lone `\r` become `\n`; `\n` is kept;
// - every other C0 and C1 control character, and U+2028/U+2029, becomes a space;
// - the bidi embedding, override and isolate controls U+202A–U+202E and U+2066–U+2069 are removed;
// - everything else, surrogate pairs included, is kept as it is.
// The code points are listed explicitly: no Unicode property tables, so every runtime agrees.

/** Player-authored text cleaned for spectators. */
export function cleanText(s: string): string {
  let out = "";
  let from = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    let put: string | null = null;
    let skip = 0;
    if (c === 0x0d) {
      put = "\n";
      if (s.charCodeAt(i + 1) === 0x0a) skip = 1;
    } else if (c === 0x0a) {
      continue;
    } else if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) {
      put = " ";
    } else if ((c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) {
      put = "";
    } else {
      continue;
    }
    out += s.slice(from, i) + put;
    i += skip;
    from = i + 1;
  }
  return from === 0 ? s : out + s.slice(from);
}

/** A JSON value with every string (keys excepted) cleaned. */
export function cleanJson(value: Json): Json {
  if (typeof value === "string") return cleanText(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(cleanJson);
  return cleanObject(value);
}

/** A JSON object with every string value cleaned (a fresh object). */
export function cleanObject(value: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(value)) {
    Object.defineProperty(out, k, {
      value: cleanJson(v),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/**
 * The first `n` UTF-16 code units of `s` (one fewer when the last kept unit would be the first half
 * of a surrogate pair).
 */
export function cutText(s: string, n: number): string {
  if (s.length <= n) return s;
  const last = s.charCodeAt(n - 1);
  return s.slice(0, last >= 0xd800 && last <= 0xdbff ? n - 1 : n);
}
