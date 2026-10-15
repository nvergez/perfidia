// The public thought (phase-2 design §3.5): the text of the turn's terminal reply, cleaned the way
// the gateway cleans player text (control characters and line breaks become spaces, §8.2),
// whitespace collapsed, cut at 400 characters. Spectators read it; no agent ever does.

export const THOUGHT_MAX = 400;

/** C0, DEL, C1 and the line and paragraph separators: the gateway's `stripControl` set. */
function isControl(c: number): boolean {
  return c < 32 || (c >= 127 && c < 160) || c === 0x2028 || c === 0x2029;
}

/** The thought of a reply's text blocks; `undefined` when nothing is left. */
export function thoughtOf(texts: readonly string[]): string | undefined {
  let s = "";
  const joined = texts.join(" ");
  for (let i = 0; i < joined.length; i += 1) s += isControl(joined.charCodeAt(i)) ? " " : joined[i];
  s = s.replaceAll(/\s+/g, " ").trim();
  if (s === "") return undefined;
  if (s.length <= THOUGHT_MAX) return s;
  let end = THOUGHT_MAX - 1;
  // Never cut a surrogate pair in half.
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  return `${s.slice(0, end).trimEnd()}…`;
}
