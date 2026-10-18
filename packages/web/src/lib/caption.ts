// A moment's title (server text such as `p2 betrayed its ally p3 at c18` or `Alliance a2
// dissolved`) as parts the views render with names: players as "Opportunist (bot) · p2",
// alliances as “League p2” a2 (the name from the feed's history: two alliances may share one), a
// quoted name kept as it is (`Alliance a1 "War p1" formed`: no id inside it is replaced). Pure.

export type TitlePart =
  | { readonly k: "text"; readonly text: string }
  | { readonly k: "player"; readonly id: string }
  | { readonly k: "alliance"; readonly id: string; readonly name: string | null };

export function titleParts(
  title: string,
  isPlayer: (id: string) => boolean,
  allianceName: (id: string) => string | null,
): TitlePart[] {
  const out: TitlePart[] = [];
  const push = (text: string): void => {
    if (text === "") return;
    const last = out.at(-1);
    if (last?.k === "text") out[out.length - 1] = { k: "text", text: last.text + text };
    else out.push({ k: "text", text });
  };
  // Quoted segments stay text; ids are read only outside them.
  const segments = title.split(/("[^"]*")/);
  segments.forEach((seg, i) => {
    if (i % 2 === 1) {
      push(seg);
      return;
    }
    const next = segments[i + 1] ?? "";
    const tokens = seg.split(/\b([pa]\d+)\b/);
    tokens.forEach((tok, j) => {
      if (j % 2 === 0) {
        push(tok);
        return;
      }
      if (tok.startsWith("p") && isPlayer(tok)) {
        out.push({ k: "player", id: tok });
        return;
      }
      if (tok.startsWith("a")) {
        // `a1 "War p1"`: the title names it already.
        const named = j === tokens.length - 2 && (tokens[j + 1] ?? "") === " " && next !== "";
        const name = named ? null : allianceName(tok);
        out.push({ k: "alliance", id: tok, name });
        return;
      }
      push(tok);
    });
  });
  return out;
}
