// The orchestrator's internal layers and source rules (phase-2 design §1.1), checked on every
// non-test source of the package:
// - imports follow the layer table (model ← seat, budget, log ← arena), and `@anthropic-ai/sdk` is
//   imported by `model/anthropic.ts` alone (type-only imports count: they are layer edges too);
// - no source reads the environment outside `arena/`, and no source names an `ANTHROPIC_*`
//   variable (only `PERFIDIA_ANTHROPIC_*` exist for the harness);
// - the seat, budget and model layers read no wall clock and no randomness of their own (both are
//   injected, so retries and fake runs are deterministic);
// - boundary: no string literal names a building, unit or queue id of a published ruleset, so the
//   prompts and profiles stay ruleset-agnostic and survive reskins.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { RULESETS, createMatch, idKeyFromSeed } from "@perfidia/engine";

const DIR = import.meta.dir;

const sources: readonly string[] = [...new Bun.Glob("**/*.ts").scanSync(DIR)]
  .filter((f) => !f.endsWith(".test.ts"))
  .map((f) => f.split("\\").join("/"))
  .toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const text = (f: string): string => readFileSync(join(DIR, f), "utf8");

// Lexing -------------------------------------------------------------------------------------------

/**
 * The source with comments blanked out, and its string literals (quoted strings and the static
 * parts of template literals). Enough for this package's sources, whose regular expressions hold no
 * quote and no comment opener.
 */
function lex(src: string): { code: string; strings: string[] } {
  let code = "";
  const strings: string[] = [];
  let i = 0;
  const quoted = (q: string): void => {
    let s = "";
    code += q;
    i += 1;
    while (i < src.length && src[i] !== q) {
      if (src[i] === "\\") {
        s += src.slice(i, i + 2);
        code += src.slice(i, i + 2);
        i += 2;
      } else {
        s += src[i];
        code += src[i];
        i += 1;
      }
    }
    if (i >= src.length) throw new Error(`unterminated string at ${i}`);
    code += q;
    i += 1;
    strings.push(s);
  };
  const template = (): void => {
    let s = "";
    code += "`";
    i += 1;
    while (i < src.length && src[i] !== "`") {
      if (src[i] === "\\") {
        s += src.slice(i, i + 2);
        code += src.slice(i, i + 2);
        i += 2;
      } else if (src[i] === "$" && src[i + 1] === "{") {
        strings.push(s);
        s = "";
        code += "${";
        i += 2;
        let depth = 1;
        while (i < src.length && depth > 0) {
          const c = src[i];
          if (c === "{") depth += 1;
          if (c === "}") depth -= 1;
          if (depth === 0) {
            code += "}";
            i += 1;
          } else step();
        }
      } else {
        s += src[i];
        code += src[i];
        i += 1;
      }
    }
    code += "`";
    i += 1;
    strings.push(s);
  };
  const step = (): void => {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i += 1;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
    } else if (c === '"' || c === "'") {
      quoted(c);
    } else if (c === "`") {
      template();
    } else {
      code += c ?? "";
      i += 1;
    }
  };
  while (i < src.length) step();
  return { code, strings };
}

/** Module specifiers of a source: static imports and re-exports (type-only included), dynamic imports. */
function importsOf(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s+"([^"]+)"/gms)) {
    if (m[1] !== undefined) out.push(m[1]);
  }
  for (const m of src.matchAll(/^\s*import\s+"([^"]+)"/gm)) if (m[1] !== undefined) out.push(m[1]);
  for (const m of src.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g))
    if (m[1] !== undefined) out.push(m[1]);
  return out;
}

/** A relative specifier as a package path (`seat/agent.ts` importing `../model/x.ts` → `model/x.ts`). */
const resolveRel = (file: string, spec: string): string =>
  posix.normalize(posix.join(dirname(file), spec));

// Layers ---------------------------------------------------------------------------------------------

interface Layer {
  /** Package imports allowed (exact names). */
  readonly packages: readonly string[];
  /** Package-internal files or directories allowed (prefix match on the resolved path). */
  readonly internal: readonly string[];
}

const LAYERS: Readonly<Record<string, Layer>> = {
  model: { packages: ["@perfidia/protocol"], internal: ["model/"] },
  budget: {
    packages: ["@perfidia/protocol"],
    internal: ["budget/", "model/adapter.ts", "model/prices.ts"],
  },
  log: {
    packages: ["@perfidia/protocol", "@perfidia/engine/core", "node:fs", "node:path"],
    internal: ["log/", "model/adapter.ts"],
  },
  seat: {
    packages: ["@perfidia/protocol", "@perfidia/engine/core"],
    internal: [
      "seat/",
      "model/adapter.ts",
      "model/clock.ts",
      "model/rate.ts",
      "budget/",
      "log/calls.ts",
      "log/schema.ts",
    ],
  },
};

const SDK = /^@anthropic-ai\/sdk(\/|$)/;

function layerProblems(file: string, src: string): string[] {
  const problems: string[] = [];
  const top = file.includes("/") ? (file.split("/")[0] ?? "") : "";
  for (const spec of importsOf(src)) {
    if (SDK.test(spec)) {
      if (file !== "model/anthropic.ts") problems.push(`${file}: imports the SDK (${spec})`);
      continue;
    }
    if (top === "" || top === "arena") continue;
    const layer = LAYERS[top];
    if (layer === undefined) {
      problems.push(`${file}: in no layer`);
      continue;
    }
    if (spec.startsWith(".")) {
      const target = resolveRel(file, spec);
      if (!layer.internal.some((p) => (p.endsWith("/") ? target.startsWith(p) : target === p))) {
        problems.push(`${file}: imports ${target}`);
      }
    } else if (!layer.packages.includes(spec)) {
      problems.push(`${file}: imports ${spec}`);
    }
  }
  return problems;
}

// Ruleset ids ----------------------------------------------------------------------------------------

/** Building, unit and queue ids of every published ruleset (`build`, the generic queue, excepted). */
function publishedIds(): Set<string> {
  const ids = new Set<string>();
  for (const r of RULESETS.filter((x) => x.status === "published")) {
    const m = createMatch(
      {
        ruleset: r.ref,
        overrides: {},
        seed: 1,
        idKey: idKeyFromSeed(1),
        seats: Array.from({ length: 6 }, (_, i) => ({ id: `p${i + 1}` as const })),
      },
      r,
    );
    const rules: unknown = m.rules;
    const listIds = (key: string): void => {
      const list: unknown =
        rules !== null && typeof rules === "object" ? Reflect.get(rules, key) : null;
      if (Array.isArray(list)) {
        for (const x of list) {
          const id: unknown = x !== null && typeof x === "object" ? Reflect.get(x, "id") : x;
          if (typeof id === "string") ids.add(id);
        }
      } else if (list !== null && typeof list === "object") {
        for (const k of Object.keys(list)) ids.add(k);
      }
    };
    listIds("buildings");
    listIds("units");
    listIds("queues");
  }
  ids.delete("build");
  return ids;
}

// Tests ----------------------------------------------------------------------------------------------

describe("orchestrator architecture", () => {
  test("the scan finds the sources and lexes them", () => {
    expect(sources).toContain("model/anthropic.ts");
    expect(sources).toContain("seat/agent.ts");
    expect(sources).toContain("budget/ledger.ts");
    expect(sources).toContain("log/calls.ts");
    const { code, strings } = lex(
      'const a = "x"; // "y"\nconst b = `t ${c ? "u" : `v`} w`; /* z */',
    );
    expect(strings).toEqual(["x", "t ", "u", "v", " w"]);
    expect(code).not.toContain("y");
    expect(code).not.toContain("z");
    expect(
      importsOf('import type {\n  A,\n} from "../model/adapter.ts";\nexport * from "./x.ts";'),
    ).toEqual(["../model/adapter.ts", "./x.ts"]);
    // The checker itself catches violations.
    expect(layerProblems("seat/x.ts", 'import Anthropic from "@anthropic-ai/sdk";')).toEqual([
      "seat/x.ts: imports the SDK (@anthropic-ai/sdk)",
    ]);
    expect(layerProblems("seat/x.ts", 'import type { T } from "@perfidia/gateway";')).toEqual([
      "seat/x.ts: imports @perfidia/gateway",
    ]);
    expect(layerProblems("budget/x.ts", 'import { s } from "../seat/agent.ts";')).toEqual([
      "budget/x.ts: imports seat/agent.ts",
    ]);
  });

  test("imports follow the layer table; the SDK is imported by model/anthropic.ts alone", () => {
    const problems = sources.flatMap((f) => layerProblems(f, text(f)));
    expect(problems).toEqual([]);
    expect(importsOf(text("model/anthropic.ts")).filter((s) => SDK.test(s)).length).toBeGreaterThan(
      0,
    );
  });

  test("no environment read outside arena/, and no ANTHROPIC_* variable named anywhere", () => {
    const found: string[] = [];
    for (const f of sources) {
      const { code, strings } = lex(text(f));
      if (!f.startsWith("arena/") && /\b(process\.env|Bun\.env|import\.meta\.env)\b/.test(code)) {
        found.push(`${f}: reads the environment`);
      }
      for (const s of strings) {
        if (/(^|[^_A-Z])ANTHROPIC_[A-Z_]+/.test(s)) found.push(`${f}: names ${s}`);
      }
    }
    expect(found).toEqual([]);
  });

  test("seat, budget and model (but the SDK adapter's default timer) take time and randomness from the injected clock", () => {
    const found: string[] = [];
    for (const f of sources) {
      if (!/^(seat|budget|model)\//.test(f) || f === "model/anthropic.ts") continue;
      const { code } = lex(text(f));
      for (const m of code.matchAll(
        /\b(Date\.now|new Date|Math\.random|performance\.now|setTimeout|setInterval|crypto\.)/g,
      )) {
        found.push(`${f}: ${m[1] ?? ""}`);
      }
    }
    expect(found).toEqual([]);
  });

  test("no string literal names a building, unit or queue id of a published ruleset", () => {
    const ids = publishedIds();
    expect(ids.has("hoplite")).toBe(true);
    expect(ids.has("wall")).toBe(true);
    const found: string[] = [];
    for (const f of sources) {
      for (const s of lex(text(f)).strings) {
        for (const w of s.split(/[^A-Za-z0-9_-]+/)) {
          if (ids.has(w.toLowerCase()))
            found.push(`${f}: ${w} in ${JSON.stringify(s.slice(0, 60))}`);
        }
      }
    }
    expect(found).toEqual([]);
  });
});
