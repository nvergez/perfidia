// The ruleset boundary in bot sources (docs/architecture.md §2.3, §11.1, §13.4): outside `hints.ts`,
// no string literal names a perfidia-1 building, unit or queue id of any version (`build` excepted,
// the generic queue) or a ruleset id; and no module-level mutable state, so bot instances cannot share caches.
// The scan reads every non-test source of this package, comments removed.

import { describe, expect, test } from "bun:test";

const DIR = import.meta.dir;
const FORBIDDEN: ReadonlySet<string> = new Set([
  "hall",
  "lumber",
  "quarry",
  "mine",
  "warehouse",
  "barracks",
  "harbor",
  "wall",
  "guard",
  "raider",
  "settler",
  "transport",
  "warship",
  // perfidia-1@1.1.0's renamed ids (docs/rulesets/perfidia-1.md §0.1).
  "acropolis",
  "woodcutter",
  "goldmine",
  "hoplite",
  "peltast",
  "trireme",
  "olympus",
  "perfidia-1",
  "sandbox-1",
]);

const sources = [...new Bun.Glob("**/*.ts").scanSync(DIR)]
  .filter((f) => !f.endsWith(".test.ts"))
  .toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * The string literals of a TypeScript source (quoted strings and the static parts of template
 * literals, `${…}` expressions scanned recursively), with comments skipped. Enough for this
 * package's sources, whose regular expressions hold no quote and no comment opener.
 */
function stringLiterals(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  const template = (): void => {
    let text = "";
    i += 1;
    while (i < src.length && src[i] !== "`") {
      if (src[i] === "\\") {
        text += src.slice(i, i + 2);
        i += 2;
      } else if (src[i] === "$" && src[i + 1] === "{") {
        out.push(text);
        text = "";
        i += 2;
        let depth = 1;
        while (i < src.length && depth > 0) {
          if (src[i] === "{") depth += 1;
          else if (src[i] === "}") depth -= 1;
          if (depth > 0) step();
          else i += 1;
        }
      } else {
        text += src[i];
        i += 1;
      }
    }
    out.push(text);
    i += 1;
  };
  const step = (): void => {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i += 1;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
    } else if (c === '"' || c === "'") {
      let text = "";
      i += 1;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\") {
          text += src.slice(i, i + 2);
          i += 2;
        } else {
          text += src[i];
          i += 1;
        }
      }
      out.push(text);
      i += 1;
    } else if (c === "`") {
      template();
    } else {
      i += 1;
    }
  };
  while (i < src.length) step();
  return out;
}

async function read(): Promise<[string, string][]> {
  const texts = await Promise.all(sources.map((f) => Bun.file(`${DIR}/${f}`).text()));
  return sources.map((f, i) => [f, texts[i]!]);
}

/** Literals naming a forbidden id: the whole literal, or one of its words. */
function offenders(src: string): string[] {
  return stringLiterals(src).filter(
    (s) => FORBIDDEN.has(s) || s.split(/[^a-z0-9-]+/).some((w) => FORBIDDEN.has(w)),
  );
}

describe("bots boundary scan", () => {
  test("the lexer finds literals and skips comments", () => {
    const src = [
      "// a comment naming hall",
      "/* and wall */",
      'const a = "guard";',
      "const b = 'x';",
      "const c = `raid ${d ? \"wall\" : 'no'} now`;",
    ].join("\n");
    expect(stringLiterals(src)).toEqual(["guard", "x", "raid ", "wall", "no", " now"]);
    expect(offenders(src)).toEqual(["guard", "wall"]);
  });

  test("sources are found", () => {
    expect(sources).toContain("agent.ts");
    expect(sources).toContain("strategies/rusher.ts");
    expect(sources).toContain("hints.ts");
  });

  test("hints.ts is the only file naming a perfidia-1 id or a ruleset id", async () => {
    const texts = await read();
    const found: Record<string, string[]> = {};
    for (const [f, text] of texts) {
      const bad = offenders(text);
      if (bad.length > 0) found[f] = bad;
    }
    expect(Object.keys(found)).toEqual(["hints.ts"]);
  });

  test("no module-level mutable state", async () => {
    const found: string[] = [];
    for (const [f, text] of await read()) {
      for (const [n, line] of text.split("\n").entries()) {
        if (/^(export )?(let|var) /.test(line)) found.push(`${f}:${n + 1}: ${line}`);
        if (/^(export )?const \w+(: [^=]+)? = new (Map|Set|WeakMap|WeakSet|Array)\b/.test(line)) {
          found.push(`${f}:${n + 1}: ${line}`);
        }
        if (/^(export )?const \w+(: [^=]+)? = [[{]/.test(line))
          found.push(`${f}:${n + 1}: ${line}`);
      }
    }
    expect(found).toEqual([]);
  });
});
