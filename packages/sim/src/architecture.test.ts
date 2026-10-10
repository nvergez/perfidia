// Source scan for the purity and layer rules that lint cannot express (docs/architecture.md
// §2.3, §2.4, §6.1). It reads every non-test source of protocol, engine, gateway and bots and fails
// on the `**` and `**=` operators, on any `Math` reference other than an allowlisted member, on
// every forbidden edge of the engine layer matrix (type-only imports included) and on imports that
// cross package boundaries other than through the declared upstream packages.
//
// It uses a small TypeScript lexer rather than `Bun.Transpiler`: `transformSync` and `scan` strip
// type-only imports and `export type … from`, which the layer matrix must see.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../../..");

/** Packages whose non-test sources must stay pure (§2.4), with the upstream packages they may import (§2.1). */
const SCANNED_PACKAGES: Readonly<Record<string, readonly string[]>> = {
  protocol: [],
  engine: ["protocol"],
  gateway: ["protocol", "engine"],
  bots: ["protocol", "gateway"],
};

/** The only `Math` members that are exactly specified by ECMAScript and allowed in pure code (§2.4). */
const MATH_ALLOWLIST: ReadonlySet<string> = new Set([
  "abs",
  "ceil",
  "floor",
  "trunc",
  "sign",
  "min",
  "max",
  "round",
  "imul",
  "clz32",
  "sqrt",
]);

// ---------------------------------------------------------------------------------------------
// Lexer

type TokenKind = "name" | "punct" | "string" | "template" | "regex" | "number";

interface Token {
  readonly kind: TokenKind;
  /** Source text, except for strings, whose value is the cooked content without quotes. */
  readonly value: string;
  readonly pos: number;
}

class ScanError extends Error {
  readonly pos: number;
  constructor(message: string, pos: number) {
    super(message);
    this.pos = pos;
  }
}

const PUNCTUATORS = [
  ">>>=",
  "...",
  "===",
  "!==",
  "**=",
  "<<=",
  ">>=",
  ">>>",
  "&&=",
  "||=",
  "??=",
  "=>",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "??",
  "?.",
  "++",
  "--",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
  "**",
  "<<",
  ">>",
];

/** Keywords after which a `/` starts a regular expression rather than a division. */
const REGEX_AFTER: ReadonlySet<string> = new Set([
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

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  n: "\n",
  r: "\r",
  t: "\t",
  b: "\b",
  f: "\f",
  v: "\v",
  "0": "\0",
};

const NUMBER =
  /(?:0[xX][\da-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)n?/y;
const NAME = /#?[A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*/y;

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= "0" && c <= "9";
}

/**
 * Splits TypeScript source into tokens, dropping whitespace and comments. Strings, template text
 * and regular expressions become opaque tokens, so their content never counts as code.
 */
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const braces: ("brace" | "template")[] = [];
  const n = source.length;
  let i = 0;
  // True when the previous token ends an expression, so a `/` is a division.
  let exprEnd = false;

  const push = (kind: TokenKind, value: string, pos: number, endsExpression: boolean): void => {
    tokens.push({ kind, value, pos });
    exprEnd = endsExpression;
  };

  // Scans template text from `i` (just after "`" or after the "}" closing a substitution).
  const scanTemplate = (start: number): void => {
    while (i < n) {
      const c = source[i];
      if (c === "\\") {
        i += 2;
      } else if (c === "`") {
        i += 1;
        push("template", source.slice(start, i), start, true);
        return;
      } else if (c === "$" && source[i + 1] === "{") {
        i += 2;
        braces.push("template");
        push("template", source.slice(start, i), start, false);
        return;
      } else {
        i += 1;
      }
    }
    throw new ScanError("unterminated template literal", start);
  };

  // Returns the end of a regular expression literal starting at `i`, or -1 if there is none.
  const regexEnd = (): number => {
    let j = i + 1;
    let inClass = false;
    while (j < n) {
      const c = source[j];
      if (c === "\n" || c === "\r") return -1;
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (inClass) {
        if (c === "]") inClass = false;
      } else if (c === "[") {
        inClass = true;
      } else if (c === "/") {
        j += 1;
        while (j < n && /[A-Za-z]/.test(source[j] ?? "")) j += 1;
        return j;
      }
      j += 1;
    }
    return -1;
  };

  if (source.startsWith("#!")) {
    const eol = source.indexOf("\n");
    i = eol < 0 ? n : eol;
  }

  while (i < n) {
    const c = source[i] ?? "";
    const start = i;
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      const eol = source.indexOf("\n", i);
      i = eol < 0 ? n : eol;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end < 0) throw new ScanError("unterminated block comment", start);
      i = end + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      let cooked = "";
      i += 1;
      for (;;) {
        const ch = source[i];
        if (ch === undefined || ch === "\n") throw new ScanError("unterminated string", start);
        if (ch === c) break;
        if (ch === "\\") {
          const next = source[i + 1] ?? "";
          if (next === "\r" && source[i + 2] === "\n") i += 1;
          else if (next !== "\n" && next !== "\r") cooked += SIMPLE_ESCAPES[next] ?? next;
          i += 2;
          continue;
        }
        cooked += ch;
        i += 1;
      }
      i += 1;
      push("string", cooked, start, true);
      continue;
    }
    if (c === "`") {
      i += 1;
      scanTemplate(start);
      continue;
    }
    if (c === "}" && braces.at(-1) === "template") {
      braces.pop();
      i += 1;
      scanTemplate(start);
      continue;
    }
    if (isDigit(c) || (c === "." && isDigit(source[i + 1]))) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(source);
      if (m === null) throw new ScanError("malformed number", start);
      i += m[0].length;
      push("number", m[0], start, true);
      continue;
    }
    NAME.lastIndex = i;
    const name = NAME.exec(source);
    if (name !== null) {
      i += name[0].length;
      push("name", name[0], start, !REGEX_AFTER.has(name[0]));
      continue;
    }
    if (c === "/" && !exprEnd) {
      const end = regexEnd();
      if (end > 0) {
        i = end;
        push("regex", source.slice(start, end), start, true);
        continue;
      }
    }
    let p = PUNCTUATORS.find((candidate) => source.startsWith(candidate, i)) ?? c;
    if (p === "?." && isDigit(source[i + 2])) p = "?";
    i += p.length;
    if (p === "{") braces.push("brace");
    else if (p === "}") braces.pop();
    // A `!`, `++` or `--` right after an expression is postfix (non-null assertion, increment).
    const postfix = (p === "!" || p === "++" || p === "--") && exprEnd;
    push("punct", p, start, p === ")" || p === "]" || p === "}" || postfix);
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// Checks on tokens

interface Hit {
  readonly pos: number;
  readonly message: string;
}

function isPunct(token: Token | undefined, value: string): boolean {
  return token?.kind === "punct" && token.value === value;
}

function isName(token: Token | undefined, value?: string): boolean {
  return token?.kind === "name" && (value === undefined || token.value === value);
}

function isMemberAccess(previous: Token | undefined): boolean {
  return isPunct(previous, ".") || isPunct(previous, "?.");
}

function operatorHits(tokens: readonly Token[]): Hit[] {
  return tokens
    .filter((t) => t.kind === "punct" && (t.value === "**" || t.value === "**="))
    .map((t) => ({
      pos: t.pos,
      message: `the \`${t.value}\` operator is implementation-approximated; use a literal or core's ipow (§6.1)`,
    }));
}

function mathHits(tokens: readonly Token[]): Hit[] {
  const hits: Hit[] = [];
  tokens.forEach((t, k) => {
    if (!isName(t, "Math")) return;
    const member = tokens[k + 2];
    if (
      isPunct(tokens[k + 1], ".") &&
      member?.kind === "name" &&
      MATH_ALLOWLIST.has(member.value)
    ) {
      return;
    }
    const used =
      isPunct(tokens[k + 1], ".") && member?.kind === "name" ? `Math.${member.value}` : "Math";
    hits.push({
      pos: t.pos,
      message: `\`${used}\` is not allowed: only Math.{${[...MATH_ALLOWLIST].join(",")}} may be referenced, directly (§2.4, §6.1)`,
    });
  });
  return hits;
}

interface ImportRef {
  /** The module specifier, or null for a dynamic import whose argument is not a string literal. */
  readonly specifier: string | null;
  readonly pos: number;
}

/**
 * Every module reference in the tokens: static imports (type-only included), side-effect imports,
 * re-exports (`export … from`, `export type … from`), dynamic and type-level `import(…)`,
 * `import x = require(…)` and `require(…)`.
 */
function importRefs(tokens: readonly Token[]): ImportRef[] {
  const refs = new Map<number, ImportRef>();
  const add = (k: number): void => {
    const t = tokens[k];
    if (t?.kind === "string") refs.set(t.pos, { specifier: t.value, pos: t.pos });
  };
  // Finds `from "x"` after an import or export clause, stopping at the end of the statement.
  const fromClause = (k: number): void => {
    for (let j = k; j < tokens.length; j += 1) {
      const t = tokens[j];
      if (isPunct(t, ";") || isName(t, "import") || isName(t, "export")) return;
      if (isName(t, "from") && tokens[j + 1]?.kind === "string") {
        add(j + 1);
        return;
      }
      if (isPunct(t, "=")) {
        if (isName(tokens[j + 1], "require") && isPunct(tokens[j + 2], "(")) add(j + 3);
        return;
      }
    }
  };

  tokens.forEach((t, k) => {
    if (t.kind !== "name" || isMemberAccess(tokens[k - 1])) return;
    const next = tokens[k + 1];
    if (t.value === "import") {
      if (isPunct(next, "(")) {
        const arg = tokens[k + 2];
        if (
          arg?.kind === "string" &&
          (isPunct(tokens[k + 3], ")") || isPunct(tokens[k + 3], ","))
        ) {
          add(k + 2);
        } else {
          refs.set(t.pos, { specifier: null, pos: t.pos });
        }
      } else if (next?.kind === "string") {
        add(k + 1);
      } else if (next?.kind === "name" || isPunct(next, "{") || isPunct(next, "*")) {
        fromClause(k + 1);
      }
    } else if (t.value === "export") {
      let j = k + 1;
      if (isName(tokens[j], "type")) j += 1;
      if (isPunct(tokens[j], "*")) {
        fromClause(j + 1);
      } else if (isPunct(tokens[j], "{")) {
        let depth = 0;
        for (; j < tokens.length; j += 1) {
          if (isPunct(tokens[j], "{")) depth += 1;
          if (isPunct(tokens[j], "}")) depth -= 1;
          if (depth === 0) break;
        }
        if (isName(tokens[j + 1], "from")) add(j + 2);
      }
    } else if (t.value === "require" && isPunct(next, "(") && tokens[k + 2]?.kind === "string") {
      add(k + 2);
    }
  });
  return [...refs.values()].toSorted((a, b) => a.pos - b.pos);
}

// ---------------------------------------------------------------------------------------------
// Engine layers (§2.3)

/** Engine groups that are one directory each and one layer each. */
const GROUPS = ["core", "contracts", "kernel", "testing", "std", "domain"] as const;

type Layer = (typeof GROUPS)[number] | "registry" | "top" | `ruleset:${string}`;

function asGroup(name: string): Layer | undefined {
  return GROUPS.find((group) => group === name);
}

/** What each layer may import besides itself; `rulesets/<id>` may also import its own directory. */
const MAY_IMPORT: Readonly<Record<string, readonly string[]>> = {
  core: [],
  contracts: ["protocol"],
  kernel: ["protocol", "core", "contracts"],
  std: ["protocol", "core", "contracts"],
  domain: ["protocol", "core", "contracts", "std"],
  ruleset: ["protocol", "core", "contracts", "std", "domain"],
};

/** Layers allowed to import anything in the engine except the top barrel. */
const OPEN_LAYERS: ReadonlySet<string> = new Set(["registry", "testing", "top"]);

function layerKind(layer: Layer): string {
  return layer.startsWith("ruleset:") ? "ruleset" : layer;
}

function layerName(layer: Layer): string {
  if (layer.startsWith("ruleset:")) return `rulesets/${layer.slice("ruleset:".length)}`;
  if (layer === "registry") return "rulesets/index.ts (registry)";
  if (layer === "top") return "the top barrel (src/index.ts)";
  return layer;
}

const SOURCE_FILE = /\.[cm]?[jt]sx?$/;

/**
 * The layer of a path inside `packages/engine/src` (forward slashes, "" for `src` itself), or
 * null when it belongs to no layer of §2.3. `isDirectory` tells a directory import from a file.
 */
function engineLayer(path: string, isDirectory: boolean): Layer | null {
  const segments = path === "" ? [] : path.split("/");
  const [first, second] = segments;
  if (first === undefined) return "top";
  if (segments.length === 1 && !isDirectory)
    return /^index\.[cm]?[jt]sx?$/.test(first) ? "top" : null;
  const group = asGroup(first);
  if (group !== undefined) return group;
  if (first !== "rulesets") return null;
  if (second === undefined) return "registry";
  if (segments.length === 2 && !isDirectory) return "registry";
  return `ruleset:${second}`;
}

/** The layer an `@perfidia/engine…` specifier names through the exports map, or null if none. */
function engineExportLayer(specifier: string): Layer | null {
  if (specifier === "@perfidia/engine") return "top";
  const sub = specifier.slice("@perfidia/engine/".length);
  const group = asGroup(sub);
  if (group !== undefined) return group;
  if (sub === "rulesets") return "registry";
  // `./rulesets/*` maps `*` to `src/rulesets/*/index.ts`, and `*` may itself contain slashes.
  const ruleset = /^rulesets\/([^/]+)/.exec(sub);
  return ruleset?.[1] === undefined ? null : `ruleset:${ruleset[1]}`;
}

type Target =
  | { readonly kind: "layer"; readonly layer: Layer }
  | { readonly kind: "package"; readonly name: string }
  | { readonly kind: "external" }
  | { readonly kind: "invalid"; readonly reason: string };

/** Minimal file-system view, so the self-tests can scan virtual files. */
interface FsView {
  isDirectory(absolutePath: string): boolean | undefined;
}

const realFs: FsView = {
  isDirectory(absolutePath) {
    if (existsSync(absolutePath)) return statSync(absolutePath).isDirectory();
    if (existsSync(`${absolutePath}.ts`)) return false;
    return undefined;
  },
};

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

/** Resolves a specifier written in `file` (repo-relative) for the package `pkg`. */
function resolveTarget(file: string, pkg: string, specifier: string, fs: FsView): Target {
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const srcRoot = join(REPO_ROOT, "packages", pkg, "src");
    const absolute = resolve(REPO_ROOT, dirname(file), specifier);
    const inSrc = toPosix(relative(srcRoot, absolute));
    if (inSrc.startsWith("..") || inSrc.startsWith("/")) {
      return {
        kind: "invalid",
        reason: `relative import leaves packages/${pkg}/src; import other packages through their public paths (§15.1)`,
      };
    }
    if (pkg !== "engine") return { kind: "package", name: pkg };
    const isDirectory = fs.isDirectory(absolute) ?? !SOURCE_FILE.test(absolute);
    const layer = engineLayer(inSrc, isDirectory);
    return layer === null
      ? { kind: "invalid", reason: `"${inSrc}" is in no engine layer of §2.3` }
      : { kind: "layer", layer };
  }
  const scoped = /^@perfidia\/([^/]+)/.exec(specifier);
  if (scoped?.[1] === undefined) return { kind: "external" };
  if (scoped[1] === "engine" && pkg === "engine") {
    const layer = engineExportLayer(specifier);
    return layer === null
      ? { kind: "invalid", reason: "not a path of the engine exports map (§2.2)" }
      : { kind: "layer", layer };
  }
  return { kind: "package", name: scoped[1] };
}

/** The reason an edge from `from` to `target` is forbidden in the engine, or null if it is allowed. */
function engineEdgeViolation(from: Layer, target: Target): string | null {
  const kind = layerKind(from);
  const open = OPEN_LAYERS.has(kind);
  const allowed = MAY_IMPORT[kind] ?? [];
  const rule = open
    ? "it may import anything in the engine except the top barrel"
    : `it may import ${allowed.length === 0 ? "nothing" : allowed.join(", ")}`;
  if (target.kind === "invalid") return target.reason;
  if (target.kind === "external") {
    return open ? null : `${layerName(from)} may not import an external package (§2.3: ${rule})`;
  }
  if (target.kind === "package") {
    if (target.name !== "protocol") {
      return `the engine must not import @perfidia/${target.name} (§2.1: protocol <- engine <- gateway <- bots <- sim)`;
    }
    return open || allowed.includes("protocol")
      ? null
      : `${layerName(from)} must not import @perfidia/protocol (§2.3: ${rule})`;
  }
  const to = target.layer;
  if (to === "top")
    return "nothing inside the engine imports the top barrel @perfidia/engine (§2.3)";
  if (to === from || open || allowed.includes(layerKind(to))) return null;
  return `${layerName(from)} must not import ${layerName(to)} (§2.3: ${rule})`;
}

// ---------------------------------------------------------------------------------------------
// File scan

interface SourceFile {
  /** Repo-relative path with forward slashes, e.g. `packages/engine/src/core/int.ts`. */
  readonly path: string;
  readonly source: string;
}

function lineCol(source: string, pos: number): string {
  let line = 1;
  let lineStart = 0;
  for (let k = 0; k < pos; k += 1) {
    if (source[k] === "\n") {
      line += 1;
      lineStart = k + 1;
    }
  }
  return `${line}:${pos - lineStart + 1}`;
}

function scanFile(file: SourceFile, fs: FsView = realFs): string[] {
  const pkg = /^packages\/([^/]+)\/src\//.exec(file.path)?.[1];
  if (pkg === undefined || !(pkg in SCANNED_PACKAGES)) {
    return [`${file.path}: not in a scanned package source directory`];
  }
  const at = (hit: Hit): string => `${file.path}:${lineCol(file.source, hit.pos)} ${hit.message}`;
  let tokens: Token[];
  try {
    tokens = tokenize(file.source);
  } catch (error) {
    if (error instanceof ScanError)
      return [at({ pos: error.pos, message: `cannot scan: ${error.message}` })];
    throw error;
  }

  const hits = [...operatorHits(tokens), ...mathHits(tokens)];
  const upstream = SCANNED_PACKAGES[pkg] ?? [];
  const layer =
    pkg === "engine" ? engineLayer(file.path.slice("packages/engine/src/".length), false) : null;
  if (pkg === "engine" && layer === null) {
    hits.push({ pos: 0, message: "this engine file is in no layer of §2.3" });
  }

  for (const ref of importRefs(tokens)) {
    if (ref.specifier === null) {
      hits.push({
        pos: ref.pos,
        message: "dynamic import with a computed specifier cannot be checked",
      });
      continue;
    }
    const target = resolveTarget(file.path, pkg, ref.specifier, fs);
    let reason: string | null = null;
    if (layer !== null) {
      reason = engineEdgeViolation(layer, target);
    } else if (target.kind === "invalid") {
      reason = target.reason;
    } else if (
      target.kind === "package" &&
      target.name !== pkg &&
      !upstream.includes(target.name)
    ) {
      reason = `@perfidia/${pkg} must not import @perfidia/${target.name} (§2.1: protocol <- engine <- gateway <- bots <- sim)`;
    }
    if (reason !== null) hits.push({ pos: ref.pos, message: `"${ref.specifier}": ${reason}` });
  }
  return hits.toSorted((a, b) => a.pos - b.pos).map(at);
}

function isTestFile(path: string): boolean {
  return /\.test\.[cm]?[jt]sx?$/.test(path);
}

function scannedFiles(): SourceFile[] {
  const glob = new Bun.Glob(
    `packages/{${Object.keys(SCANNED_PACKAGES).join(",")}}/src/**/*.{ts,tsx,mts,cts}`,
  );
  return [...glob.scanSync({ cwd: REPO_ROOT })]
    .map(toPosix)
    .filter((path) => !isTestFile(path))
    .toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((path) => ({ path, source: readFileSync(join(REPO_ROOT, path), "utf8") }));
}

// ---------------------------------------------------------------------------------------------
// The scan over the repository

describe("architecture source scan", () => {
  const files = scannedFiles();

  test("covers the non-test sources of every pure package and bots", () => {
    for (const pkg of Object.keys(SCANNED_PACKAGES)) {
      expect(files.some((f) => f.path === `packages/${pkg}/src/index.ts`)).toBe(true);
    }
    expect(files.some((f) => isTestFile(f.path))).toBe(false);
  });

  test("no violation of §2.3, §2.4 or §6.1", () => {
    expect(files.flatMap((file) => scanFile(file))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Self-tests: the scanner catches what it must and nothing else

/** Scans a virtual file: directories are told apart from files by their extension only. */
function scanVirtual(path: string, source: string): string[] {
  return scanFile({ path, source }, { isDirectory: () => undefined }).map((finding) =>
    finding.slice(path.length + 1),
  );
}

const CORE_FILE = "packages/engine/src/core/a.ts";

describe("scanner: operators", () => {
  const flagged: readonly (readonly [string, number])[] = [
    ["const a = 2 ** 3;", 1],
    ["let x = 2;\nx **= 2;", 1],
    ["const a = `t ${2 ** 3}`;", 1],
    ["const a = `${`${2 ** 3}`}` + 2 ** 4;", 2],
    // A `/` after a non-null assertion is a division, not the start of a regular expression.
    ["const a = b! / 2; const c = 2 ** 3; const d = e / 2;", 1],
    ["const a = (b)[0]! / 2; const c = 2 ** 3; const d = e / 2;", 1],
    ["const r = /x/; const n = 2 ** 2;", 1],
  ];
  for (const [source, count] of flagged) {
    test(`flags ${JSON.stringify(source)}`, () => {
      expect(scanVirtual(CORE_FILE, source)).toHaveLength(count);
    });
  }

  const ignored = [
    "// 2 ** 3",
    "/* x **= 2 */ const a = 1;",
    "/**\n * Doc comment with ** inside.\n */\nexport const a = 1;",
    'const a = "2 ** 3";',
    "const a = '**=';",
    "const a = `2 ** 3`;",
    "const r = /[**]/;",
    "const r = (/a\\/**/);",
    "const r = [/[/]**/u];",
    "const a = 2 * 3 * 4;",
    "let a = 2;\na *= 3;",
  ];
  for (const source of ignored) {
    test(`ignores ${JSON.stringify(source)}`, () => {
      expect(scanVirtual(CORE_FILE, source)).toEqual([]);
    });
  }
});

describe("scanner: Math", () => {
  const allowed = [
    "Math.floor(1);",
    "Math.sqrt(4);",
    "const a = Math.max(1, Math.min(2, 3));",
    "Math.imul(a, b) >>> Math.clz32(c);",
    '"Math.tan(1)";',
    "// Math.random()",
    "const fold = mathLike.tan(1);",
  ];
  for (const source of allowed) {
    test(`allows ${JSON.stringify(source)}`, () => {
      expect(scanVirtual(CORE_FILE, source)).toEqual([]);
    });
  }

  const flagged = [
    "Math.tan(1);",
    "Math.random();",
    "Math.pow(2, 3);",
    "Math.fround(1);",
    "const pi = Math.PI;",
    "const m = Math;\nm.tan(1);",
    'Reflect.get(Math, "tan");',
    'Math["floor"](1);',
    "const { floor } = Math;",
    "Math?.floor(1);",
    "type M = typeof Math;",
    "const t = `${Math.tan(1)}`;",
  ];
  for (const source of flagged) {
    test(`flags ${JSON.stringify(source)}`, () => {
      expect(scanVirtual(CORE_FILE, source)).toHaveLength(1);
    });
  }
});

describe("scanner: module references", () => {
  test("finds every kind of module reference, type-only ones included", () => {
    const source = [
      'import a from "./a.ts";',
      'import type { B } from "./b.ts";',
      "import {",
      "  type C,",
      "  d,",
      '} from "./c.ts";',
      'import * as e from "./e.ts";',
      'import "./f.ts";',
      'export * from "./g.ts";',
      'export * as h from "./h.ts";',
      'export type { I } from "./i.ts";',
      'export { j as default } from "./j.ts";',
      "export type * from './k.ts';",
      'type L = typeof import("./l.ts");',
      'const m = await import("./m.ts");',
      'import n = require("./n.ts");',
      'export { from } from "./o.ts";',
      'import from from "./p.ts"',
      'import type Q from "./q.ts"',
    ].join("\n");
    const expected = [
      "a",
      "b",
      "c",
      "e",
      "f",
      "g",
      "h",
      "i",
      "j",
      "k",
      "l",
      "m",
      "n",
      "o",
      "p",
      "q",
    ];
    expect(importRefs(tokenize(source)).map((r) => r.specifier)).toEqual(
      expected.map((x) => `./${x}.ts`),
    );
  });

  test("ignores look-alikes in comments, strings, members and local exports", () => {
    const source = [
      '// import "./a.ts";',
      '/* export * from "./b.ts"; */',
      "const s = \"import x from './c.ts'\";",
      "const t = `export * from './d.ts'`;",
      "const u = import.meta.url;",
      'const v = loader.import("./e.ts");',
      "const w = { import: 1, export: 2 };",
      "export { w };",
      'export const from = "./f.ts";',
    ].join("\n");
    expect(importRefs(tokenize(source))).toEqual([]);
  });

  test("reports a computed dynamic import", () => {
    expect(scanVirtual(CORE_FILE, "const m = await import(name);")).toHaveLength(1);
  });
});

describe("scanner: engine layer matrix (§2.3)", () => {
  const forbidden: readonly (readonly [string, string])[] = [
    ["core/a.ts", "@perfidia/protocol"],
    ["core/a.ts", "@perfidia/engine/contracts"],
    ["core/a.ts", "../contracts/index.ts"],
    ["core/a.ts", "zod"],
    ["contracts/a.ts", "@perfidia/engine/core"],
    ["contracts/a.ts", "../core/index.ts"],
    ["contracts/a.ts", "@perfidia/engine/kernel"],
    ["contracts/a.ts", "../std/index.ts"],
    ["kernel/a.ts", "@perfidia/engine/std"],
    ["kernel/a.ts", "../std/index.ts"],
    ["kernel/a.ts", "@perfidia/engine/domain"],
    ["kernel/a.ts", "../domain/index.ts"],
    ["kernel/a.ts", "@perfidia/engine/rulesets"],
    ["kernel/a.ts", "../rulesets/index.ts"],
    ["kernel/a.ts", "@perfidia/engine/testing"],
    ["std/a.ts", "@perfidia/engine/kernel"],
    ["std/a.ts", "../kernel/index.ts"],
    ["std/a.ts", "../kernel"],
    ["std/a.ts", "@perfidia/engine/domain"],
    ["std/a.ts", "../rulesets/x/index.ts"],
    ["std/a.ts", "@perfidia/engine/rulesets/x/sub"],
    ["domain/a.ts", "@perfidia/engine"],
    ["domain/a.ts", "../index.ts"],
    ["domain/a.ts", ".."],
    ["domain/a.ts", "@perfidia/engine/kernel"],
    ["domain/a.ts", "@perfidia/engine/rulesets/x"],
    ["rulesets/x/a.ts", "@perfidia/engine/kernel"],
    ["rulesets/x/a.ts", "../../kernel/index.ts"],
    ["rulesets/x/a.ts", "@perfidia/engine/testing"],
    ["rulesets/x/a.ts", "../../testing/index.ts"],
    ["rulesets/x/a.ts", "@perfidia/engine/rulesets"],
    ["rulesets/x/a.ts", "../index.ts"],
    ["rulesets/x/a.ts", "@perfidia/engine/rulesets/y"],
    ["rulesets/x/a.ts", "../y/index.ts"],
    ["rulesets/x/a.ts", "@perfidia/engine"],
    ["rulesets/perfidia-1/a.ts", "../sandbox-1/index.ts"],
    ["testing/a.ts", "@perfidia/engine"],
    ["rulesets/index.ts", "../index.ts"],
    ["index.ts", "@perfidia/engine"],
    ["kernel/a.ts", "@perfidia/gateway"],
    ["kernel/a.ts", "@perfidia/engine/src/core/index.ts"],
    ["kernel/a.ts", "../../../protocol/src/index.ts"],
    ["utils/a.ts", "./b.ts"],
  ];
  for (const [from, specifier] of forbidden) {
    test(`${from} must not import ${JSON.stringify(specifier)}`, () => {
      const source = `import type { T } from "${specifier}";`;
      expect(scanVirtual(`packages/engine/src/${from}`, source).length).toBeGreaterThan(0);
    });
  }

  const allowed: readonly (readonly [string, string])[] = [
    ["core/a.ts", "./b.ts"],
    ["contracts/a.ts", "@perfidia/protocol"],
    ["kernel/a.ts", "@perfidia/engine/core"],
    ["kernel/a.ts", "../contracts/index.ts"],
    ["kernel/a.ts", "./queue.ts"],
    ["std/a.ts", "@perfidia/engine/contracts"],
    ["domain/a.ts", "@perfidia/engine/std"],
    ["domain/a.ts", "../std/index.ts"],
    ["rulesets/x/a.ts", "@perfidia/engine/domain"],
    ["rulesets/x/a.ts", "../../std/index.ts"],
    ["rulesets/x/a.ts", "./combat.ts"],
    ["rulesets/x/deep/a.ts", "../index.ts"],
    ["rulesets/x/a.ts", "@perfidia/engine/rulesets/x"],
    ["rulesets/x/a.ts", "@perfidia/engine/rulesets/x/sub"],
    ["rulesets/index.ts", "./x/index.ts"],
    ["rulesets/index.ts", "@perfidia/engine/rulesets/x"],
    ["testing/a.ts", "@perfidia/engine/kernel"],
    ["testing/a.ts", "../rulesets/x/index.ts"],
    ["testing/a.ts", "fast-check"],
    ["index.ts", "./kernel/index.ts"],
    ["index.ts", "@perfidia/engine/rulesets"],
  ];
  for (const [from, specifier] of allowed) {
    test(`${from} may import ${JSON.stringify(specifier)}`, () => {
      const source = `import { T } from "${specifier}";`;
      expect(scanVirtual(`packages/engine/src/${from}`, source)).toEqual([]);
    });
  }
});

describe("scanner: package boundaries (§2.1)", () => {
  const forbidden: readonly (readonly [string, string])[] = [
    ["packages/protocol/src/a.ts", "@perfidia/engine"],
    ["packages/gateway/src/a.ts", "@perfidia/bots"],
    ["packages/gateway/src/a.ts", "../../engine/src/core/index.ts"],
    ["packages/bots/src/a.ts", "@perfidia/engine/core"],
    ["packages/bots/src/a.ts", "@perfidia/sim"],
  ];
  for (const [path, specifier] of forbidden) {
    test(`${path} must not import ${JSON.stringify(specifier)}`, () => {
      expect(scanVirtual(path, `import type { T } from "${specifier}";`)).toHaveLength(1);
    });
  }

  const allowed: readonly (readonly [string, string])[] = [
    ["packages/protocol/src/a.ts", "zod"],
    ["packages/gateway/src/runtime/a.ts", "@perfidia/engine/core"],
    ["packages/gateway/src/runtime/a.ts", "@perfidia/gateway/seat"],
    ["packages/gateway/src/runtime/a.ts", "../seat/index.ts"],
    ["packages/bots/src/a.ts", "@perfidia/gateway"],
    ["packages/bots/src/a.ts", "@perfidia/protocol"],
  ];
  for (const [path, specifier] of allowed) {
    test(`${path} may import ${JSON.stringify(specifier)}`, () => {
      expect(scanVirtual(path, `import type { T } from "${specifier}";`)).toEqual([]);
    });
  }
});
