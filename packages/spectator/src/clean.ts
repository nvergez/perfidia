import type { Json, JsonObject } from "@perfidia/protocol";

// Text hygiene for spectators (phase-3 design §2.6). Player-authored text (messages, proposals,
// thoughts, notes, reasoning) reaches viewers as plain text, so it keeps its line breaks; the
// gateway's `stripControl`, made for agents, flattens them and keeps bidi controls. Here:
// - `\r\n` and a lone `\r` become `\n`; `\n` is kept;
// - every other C0 and C1 control character, and U+2028/U+2029, becomes a space;
// - the bidi embedding, override and isolate controls U+202A–U+202E and U+2066–U+2069 are removed;
// - so are the invisible marks that can make the text shown differ from the text stored: the bidi
//   marks (LRM U+200E, RLM U+200F, ALM U+061C), the zero-width space U+200B, the word joiner and
//   invisible operators U+2060–U+2064, U+FEFF, and the tag characters U+E0000–U+E007F (a review
//   amendment to design §2.6); the zero-width non-joiner and joiner U+200C/U+200D stay, since
//   scripts and emoji sequences need them;
// - everything else, surrogate pairs included, is kept as it is.
// The code points are listed explicitly: no Unicode property tables, so every runtime agrees.

/** Player-authored text cleaned for spectators. */
export function cleanText(s: string): string {
  // A removal can join two lone surrogates into a tag character: clean until nothing changes.
  let text = s;
  for (;;) {
    const out = cleanOnce(text);
    if (out === text) return out;
    text = out;
  }
}

function cleanOnce(s: string): string {
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
    } else if (
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2066 && c <= 0x2069) ||
      c === 0x200b ||
      c === 0x200e ||
      c === 0x200f ||
      c === 0x061c ||
      (c >= 0x2060 && c <= 0x2064) ||
      c === 0xfeff
    ) {
      put = "";
    } else if (c === 0xdb40) {
      // A tag character (U+E0000–U+E007F) is the pair U+DB40, U+DC00–U+DC7F.
      const low = s.charCodeAt(i + 1);
      if (low < 0xdc00 || low > 0xdc7f) continue;
      put = "";
      skip = 1;
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

/** The longest tool name kept (a turn's results, an annotation's calls): an agent may name any. */
export const TOOL_NAME_MAX_CHARS = 64;
/** The longest label kept from the harness's logs (a refusal's category, an error's kind). */
export const LABEL_MAX_CHARS = 64;

/**
 * The first `n` UTF-16 code units of `s` (one fewer when the last kept unit would be the first half
 * of a surrogate pair).
 */
export function cutText(s: string, n: number): string {
  if (s.length <= n) return s;
  const last = s.charCodeAt(n - 1);
  return s.slice(0, last >= 0xd800 && last <= 0xdbff ? n - 1 : n);
}
