// The ruleset boundary scan (docs/architecture.md §13.4): no non-test source of engine `core`,
// `contracts`, `kernel`, `std` and `domain`, of `gateway/src`, or of `bots/src` (except `hints.ts`)
// contains a string literal naming a perfidia-1 building, unit or queue id (`build` excepted, the
// generic queue) or a ruleset id. The ids come from the registry (perfidia-1's compiled rules at
// every allowed N, and every registered ruleset id), so a renamed or added id is covered without
// editing this test. Literals are found by a small lexer that skips comments and regular
// expressions and reads the static parts of template literals.
//
// Deviation from §13.4, which excepts only `build`: the `read_notes` scope literal "mine" (§8.4)
// collides with the perfidia-1 building id `mine`, so it is allowed in exactly the files that use
// it as a scope (`ALLOWED`, file by file); the same literal anywhere else still fails, and a test
// fails when an allowed literal is gone, so the list cannot go stale.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { RULESETS, parseRulesetRef, resolveConfig } from "@perfidia/engine";
import { perfidia1_1_0_0 } from "@perfidia/engine/rulesets/perfidia-1";

const ROOT = resolve(import.meta.dir, "../../../..");

/** The scanned trees, relative to the repository root. */
const SCANNED = [
  "packages/engine/src/core",
  "packages/engine/src/contracts",
  "packages/engine/src/kernel",
  "packages/engine/src/std",
  "packages/engine/src/domain",
  "packages/gateway/src",
  "packages/bots/src",
] as const;

/** The only file allowed to name ruleset ids (§11.1). */
const EXEMPT_FILES: ReadonlySet<string> = new Set(["packages/bots/src/hints.ts"]);

/**
 * Literals that spell an id but name something else, each with its reason. Exact (file, literal)
 * pairs: the same literal anywhere else still fails.
 */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  // The `read_notes` search scope "mine" (the seat's own archive, §8.4), not the perfidia-1 mine:
  // the archive filters on it, and the briefing's `more` names a search with it.
  "packages/gateway/src/seat/archive.ts": ["mine"],
  "packages/gateway/src/present/briefing.ts": ["mine"],
};

/** perfidia-1's building, unit and queue ids at every allowed N, `build` excepted. */
function perfidiaIds(): Set<string> {
  const resolved = resolveConfig(perfidia1_1_0_0, {});
  if (!resolved.ok) throw new Error("perfidia-1's defaults do not resolve");
  const { min, max } = perfidia1_1_0_0.players(resolved.config);
  const ids = new Set<string>();
  for (let n = min; n <= max; n += 1) {
    const rules = perfidia1_1_0_0.compile(resolved.config, n);
    for (const b of rules.buildings) ids.add(b.id);
    for (const u of rules.units) ids.add(u.id);
    for (const q of rules.queues.recruit) ids.add(q.id);
  }
  ids.delete("build");
  return ids;
}

/** Every registered ruleset id (`perfidia-1`, `sandbox-1`, …). */
function rulesetIds(): Set<string> {
  const ids = new Set<string>();
  for (const r of RULESETS) {
    const parsed = parseRulesetRef(r.ref);
    if (parsed !== null) ids.add(parsed.id);
  }
  return ids;
}

// Lexer ------------------------------------------------------------------------------------------

/** Keywords after which `/` starts a regular expression. */
const REGEX_KEYWORDS: ReadonlySet<string> = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

const IDENT = /[A-Za-z0-9_$]/;

/**
 * The string literals of a TypeScript source: quoted strings (raw text between the quotes) and the
 * static parts of template literals, whose `${…}` expressions are scanned in turn. Comments and
 * regular expression literals are skipped.
 */
export function stringLiterals(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  /** The last significant token: an identifier/number, a closing bracket, or another punctuator. */
  let last: { kind: "word" | "close" | "punct"; text: string } = { kind: "punct", text: "" };

  const regexAllowed = (): boolean =>
    last.kind === "punct" || (last.kind === "word" && REGEX_KEYWORDS.has(last.text));

  const quoted = (q: string): void => {
    let text = "";
    i += 1;
    while (i < src.length && src[i] !== q) {
      if (src[i] === "\\") {
        text += src.slice(i, i + 2);
        i += 2;
      } else {
        text += src[i];
        i += 1;
      }
    }
    i += 1;
    out.push(text);
    last = { kind: "word", text: "" };
  };

  const regex = (): void => {
    i += 1;
    let inClass = false;
    while (i < src.length) {
      const c = src[i];
      if (c === "/" && !inClass) break;
      if (c === "\n") throw new Error(`unterminated regular expression at ${i}`);
      if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      i += c === "\\" ? 2 : 1;
    }
    i += 1;
    while (i < src.length && IDENT.test(src[i] ?? "")) i += 1;
    last = { kind: "word", text: "" };
  };

  /** Scans until the `}` closing a `${`, or the end; returns at the closing brace. */
  const expression = (): void => {
    let depth = 0;
    while (i < src.length) {
      if (src[i] === "}" && depth === 0) return;
      if (src[i] === "{") depth += 1;
      if (src[i] === "}") depth -= 1;
      token();
    }
  };

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
        last = { kind: "punct", text: "${" };
        expression();
        i += 1;
      } else {
        text += src[i];
        i += 1;
      }
    }
    i += 1;
    out.push(text);
    last = { kind: "word", text: "" };
  };

  const token = (): void => {
    const c = src[i] ?? "";
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i += 1;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
    } else if (c === '"' || c === "'") {
      quoted(c);
    } else if (c === "`") {
      template();
    } else if (c === "/") {
      if (regexAllowed()) regex();
      else {
        i += 1;
        last = { kind: "punct", text: "/" };
      }
    } else if (IDENT.test(c)) {
      let word = "";
      while (i < src.length && IDENT.test(src[i] ?? "")) {
        word += src[i];
        i += 1;
      }
      last = { kind: "word", text: word };
    } else if (c === ")" || c === "]" || c === "}") {
      i += 1;
      last = { kind: "close", text: c };
    } else if (/\s/.test(c)) {
      i += 1;
    } else {
      i += 1;
      last = { kind: "punct", text: c };
    }
  };

  while (i < src.length) token();
  return out;
}

/** The literals of `src` that name a forbidden id: equal to an id, or holding a ruleset id as a word. */
export function offenders(
  src: string,
  ids: ReadonlySet<string>,
  rulesets: ReadonlySet<string>,
): string[] {
  return stringLiterals(src).filter(
    (s) => ids.has(s) || rulesets.has(s) || s.split(/[^a-z0-9-]+/).some((w) => rulesets.has(w)),
  );
}

function scannedFiles(): string[] {
  const files: string[] = [];
  for (const dir of SCANNED) {
    for (const f of new Bun.Glob("**/*.{ts,tsx,mts,cts,js,mjs,cjs}").scanSync(join(ROOT, dir))) {
      if (/\.test\.[cm]?[jt]sx?$/.test(f)) continue;
      const path = `${dir}/${f}`;
      if (!EXEMPT_FILES.has(path)) files.push(path);
    }
  }
  return files.toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

describe("ruleset boundary scan (§13.4)", () => {
  const ids = perfidiaIds();
  const rulesets = rulesetIds();

  test("the forbidden ids come from the registry", () => {
    for (const id of ["hall", "barracks", "wall", "guard", "settler", "warship"]) {
      expect(ids.has(id)).toBe(true);
    }
    expect(ids.has("build")).toBe(false);
    expect([...rulesets].toSorted((a, b) => (a < b ? -1 : 1))).toEqual(["perfidia-1", "sandbox-1"]);
  });

  test("covers every scanned tree", () => {
    const files = scannedFiles();
    for (const dir of SCANNED) expect(files.some((f) => f.startsWith(`${dir}/`))).toBe(true);
    expect(files).toContain("packages/gateway/src/runtime/host.ts");
    expect(files).not.toContain("packages/bots/src/hints.ts");
    expect(files.some((f) => f.includes("/rulesets/"))).toBe(false);
  });

  test("no scanned source names a perfidia-1 id or a ruleset id", () => {
    const found: Record<string, string[]> = {};
    for (const file of scannedFiles()) {
      const allowed = new Set(ALLOWED[file] ?? []);
      const bad = offenders(readFileSync(join(ROOT, file), "utf8"), ids, rulesets).filter(
        (s) => !allowed.has(s),
      );
      if (bad.length > 0) found[relative(ROOT, join(ROOT, file))] = bad;
    }
    expect(found).toEqual({});
  });

  test("every allowed literal is still there (the allowlist cannot go stale)", () => {
    for (const [file, literals] of Object.entries(ALLOWED)) {
      const all = stringLiterals(readFileSync(join(ROOT, file), "utf8"));
      for (const l of literals) expect([file, l, all.includes(l)]).toEqual([file, l, true]);
    }
  });

  test("the lexer finds literals and skips comments and regular expressions", () => {
    const src = [
      "// a comment naming 'barracks'",
      '/* and "wall" */',
      'const a = "guard";',
      'const b = x / 2 / y; const re = /"warship"[/]\'/g.test(s);',
      "const c = `raid ${d ? \"wall\" : `in ${'hall'}`} now`;",
      "if (ruleset.id === 'perfidia-1') return `ref perfidia-1@1.0.0`;",
      'const e = f("settler") / 3;',
    ].join("\n");
    expect(stringLiterals(src)).toEqual([
      "guard",
      "raid ",
      "wall",
      "in ",
      "hall",
      "",
      " now",
      "perfidia-1",
      "ref perfidia-1@1.0.0",
      "settler",
    ]);
    expect(offenders(src, ids, rulesets)).toEqual([
      "guard",
      "wall",
      "hall",
      "perfidia-1",
      "ref perfidia-1@1.0.0",
      "settler",
    ]);
  });
});
